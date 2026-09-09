#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Inventario de TODOS los elementos cotizados (materiales y mano de obra) de la
app de costeo de PROENERGY, con su precio y su fecha, poniendo PRIMERO los que
no tienen precio para poder completarlos a mano.

Por que existe: las cotizaciones importadas de Siigo no traen costos internos
(Siigo no los maneja), asi que sus lineas quedan marcadas "[REVISAR]" con costo
$0 -- ver server/routes/siigo-materiales.routes.js. Mientras esas lineas esten
en cero, el costo, la utilidad y el margen que muestra la app no son reales.
Este script arma la hoja de trabajo para llenar esos precios de una sola vez por
material (no una vez por cotizacion).

NO INVENTA CIFRAS: si un elemento no tiene precio, la celda queda VACIA, nunca
en cero ni rellenada con un supuesto. El precio del catalogo maestro se muestra
en su propia columna, claramente marcado como referencia.

Este script SOLO LEE. No modifica nada en la aplicacion.

Salidas (en la carpeta reportes/):
  - elementos-cotizados-<fecha>.csv    vista agrupada, para revision rapida
  - elementos-cotizados-<fecha>.xlsx   dos hojas: "Para completar" y "Detalle"

Requisitos:
  Python 3.9 o superior y openpyxl:
      pip install openpyxl

NUNCA escribas tu usuario/clave en este archivo: se piden por variables de
entorno para que las escribas tu mismo en tu propia terminal.

Uso en PowerShell:
    $env:ADMIN_USERNAME = "admin"
    $env:ADMIN_PASSWORD = "tu-clave"
    python scripts/listar-elementos-cotizados.py https://tu-app.up.railway.app

Filtros opcionales (todos opcionales, se combinan; mismos que
reporte-materiales-faltantes.js):
    --desde=2026-01-01 --hasta=2026-06-30
    --estado=Aprobada,Ejecutada,Cerrada
    --idDesde=200 --idHasta=234
    --sep=,          separador del CSV (por defecto ";", que es el que espera
                     Excel en espanol)
"""

import collections
import csv
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------- argumentos

def parsear_argumentos(argv):
    posicionales = [a for a in argv if not a.startswith('--')]
    banderas = {}
    for a in argv:
        m = re.match(r'^--([a-zA-Z]+)=(.*)$', a)
        if m:
            banderas[m.group(1)] = m.group(2)

    base_url = posicionales[0].rstrip('/') if posicionales else ''
    if not base_url:
        print(
            'Uso: python scripts/listar-elementos-cotizados.py <URL_DE_LA_APP> '
            '[--desde=YYYY-MM-DD] [--hasta=YYYY-MM-DD] '
            '[--estado=Aprobada,Ejecutada] [--idDesde=N] [--idHasta=N] [--sep=,]',
            file=sys.stderr,
        )
        sys.exit(1)

    estados = None
    if banderas.get('estado'):
        estados = [s.strip() for s in banderas['estado'].split(',') if s.strip()]

    return {
        'base_url': base_url,
        'desde': banderas.get('desde'),
        'hasta': banderas.get('hasta'),
        'id_desde': int(banderas['idDesde']) if banderas.get('idDesde') else None,
        'id_hasta': int(banderas['idHasta']) if banderas.get('idHasta') else None,
        'estados': estados,
        'sep': banderas.get('sep', ';'),
    }


# ---------------------------------------------------------------- cliente API

class ClienteApi:
    """Cliente minimo de la API, con sesion por cookie.

    El token se toma del header Set-Cookie del login y se reenvia a mano en cada
    peticion, igual que hacen los scripts de reporte en Node que ya estan
    probados contra este servidor. Es mas predecible que delegar en un cookiejar.
    """

    REINTENTOS = 3

    def __init__(self, base_url):
        self.base_url = base_url
        self.cookie = None

    def _abrir(self, path, datos=None, metodo=None):
        req = urllib.request.Request(f'{self.base_url}{path}', method=metodo)
        req.add_header('Accept', 'application/json')
        req.add_header('User-Agent', 'PROENERGY-inventario-elementos/1.0')
        if self.cookie:
            req.add_header('Cookie', self.cookie)
        cuerpo = None
        if datos is not None:
            cuerpo = json.dumps(datos).encode('utf-8')
            req.add_header('Content-Type', 'application/json')

        ultimo_error = None
        for intento in range(1, self.REINTENTOS + 1):
            try:
                with urllib.request.urlopen(req, cuerpo, timeout=60) as res:
                    texto = res.read().decode('utf-8')
                    cabeceras = res.headers
                return (json.loads(texto) if texto else None), cabeceras
            except urllib.error.HTTPError as e:
                # Un error HTTP es una respuesta del servidor, no una falla de
                # red: reintentarlo daria lo mismo.
                detalle = e.read().decode('utf-8', errors='replace')
                try:
                    detalle = json.loads(detalle).get('error', detalle)
                except (ValueError, AttributeError):
                    pass
                raise RuntimeError(f'{path} -> HTTP {e.code}: {detalle}') from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                ultimo_error = getattr(e, 'reason', e)
                if intento < self.REINTENTOS:
                    time.sleep(intento)  # espera creciente antes de reintentar
        raise RuntimeError(f'{path} -> no se pudo conectar tras {self.REINTENTOS} intentos: {ultimo_error}')

    def login(self, usuario, clave):
        _, cabeceras = self._abrir('/api/login', {'username': usuario, 'password': clave})
        cookie_cruda = cabeceras.get('Set-Cookie') or ''
        m = re.search(r'sesion=[^;]+', cookie_cruda)
        if not m:
            raise RuntimeError('El login respondio OK pero no se recibio la cookie de sesion.')
        self.cookie = m.group(0)

    def get(self, path):
        datos, _ = self._abrir(path)
        return datos

    def put(self, path, datos):
        resultado, _ = self._abrir(path, datos, metodo='PUT')
        return resultado

    def post_json(self, path, datos):
        resultado, _ = self._abrir(path, datos, metodo='POST')
        return resultado


# ---------------------------------------------------------------- utilidades

def normalizar(texto):
    """Normaliza una descripcion para agrupar.

    Mismo criterio que scripts/reporte-materiales-faltantes.js: sin tildes, en
    minusculas, sin el prefijo [REVISAR] y con los espacios colapsados, para que
    los dos reportes agrupen igual.
    """
    s = unicodedata.normalize('NFD', str(texto or ''))
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = s.lower().replace('[revisar]', '')
    return re.sub(r'\s+', ' ', s).strip()


def viene_marcado_revisar(descripcion):
    return bool(re.match(r'^\s*\[revisar\]', str(descripcion or ''), re.IGNORECASE))


def numero(valor):
    """Devuelve el valor como float, o None si no es un numero utilizable.

    Un 0 se conserva como 0.0 (es un dato real: "esta en cero"), no se convierte
    en None; quien decide si eso cuenta como "sin precio" es sin_precio().
    """
    if valor is None:
        return None
    try:
        n = float(valor)
    except (TypeError, ValueError):
        return None
    return None if n != n else n  # descarta NaN


def sin_precio(valor):
    n = numero(valor)
    return n is None or n <= 0


# La carga automatica desde Siigo mete TODOS los items como material 'Directo',
# porque Siigo no distingue. Pero muchos son servicios, mano de obra o alquiler
# de equipo, y esos no tienen precio de lista: hay que costearlos con criterio
# propio. Separarlos evita perder tiempo buscando en catalogos de proveedor algo
# que nunca va a estar ahi.
PALABRAS_SERVICIO = (
    'mano de obra', 'instalacion', 'desinstalacion', 'montaje', 'desmontaje',
    'apertura', 'cierre', 'previsita', 'visita', 'gestion', 'tramite', 'descargo',
    'alquiler', 'arriendo', 'carrocanasta', 'grua', 'transporte', 'traslado',
    'revision', 'mantenimiento', 'calibracion', 'prueba', 'ensayo', 'asesoria',
    'supervision', 'cuadrilla', 'tecnico', 'ingeniero', 'certificacion',
    'diagnostico', 'inspeccion', 'puesta en marcha', 'capacitacion', 'servicio',
    'conexion', 'desconexion', 'cambio de', 'retiro', 'adecuacion', 'obra civil',
)
# Bolsas de varios items sin detallar: no son un producto de catalogo, se costean
# como un global.
PALABRAS_GLOBAL = ('accesorios consumibles', 'consumibles generales', 'varios', 'imprevistos')


def clasificar_naturaleza(descripcion):
    d = normalizar(descripcion)
    if any(p in d for p in PALABRAS_GLOBAL):
        return 'GLOBAL (bolsa de varios)'
    if any(p in d for p in PALABRAS_SERVICIO):
        return 'SERVICIO / MANO DE OBRA'
    return 'Material'


def moda(valores):
    """Valor mas repetido. Con empate gana el mayor, para no subestimar el costo."""
    if not valores:
        return None
    cuenta = collections.Counter(valores)
    tope = max(cuenta.values())
    return max(v for v, c in cuenta.items() if c == tope)


def lista_corta(valores, tope=40):
    """Une una lista en un texto, recortando si es muy larga.

    Una celda de Excel no admite mas de 32.767 caracteres; un material que
    aparezca en cientos de cotizaciones podria acercarse a ese limite.
    """
    valores = sorted(str(v) for v in valores)
    if len(valores) <= tope:
        return ', '.join(valores)
    return ', '.join(valores[:tope]) + f' ... y {len(valores) - tope} mas'


# ---------------------------------------------------------------- extraccion

def filas_de_cotizacion(detalle, resumen, proveedores):
    """Convierte una cotizacion en filas de detalle (materiales + mano de obra)."""
    cot = detalle.get('cot') or {}
    filas = []

    base = {
        'cotizacion_numero': cot.get('numero') or resumen.get('numero'),
        'cotizacion_id': cot.get('id') or resumen.get('id'),
        'cliente': cot.get('cliente') or resumen.get('cliente'),
        'estado': cot.get('estado') or resumen.get('estado'),
        'fecha_cotizacion': cot.get('fecha_cotizacion') or resumen.get('fecha_cotizacion'),
        'origen_siigo': 'Si' if cot.get('siigo_quotation_id') else 'No',
    }

    for m in detalle.get('materiales') or []:
        descripcion = (m.get('descripcion') or '').strip()
        if not descripcion:
            continue
        costo = numero(m.get('costo_unitario'))
        cantidad = numero(m.get('cantidad_presupuestada'))
        fila = dict(base)
        fila.update({
            'tipo': 'Material',
            'linea_id': m.get('id'),
            'descripcion': descripcion,
            'clasificacion': m.get('clasificacion'),
            'forma_pago': m.get('forma_pago'),
            'proveedor': proveedores.get(m.get('proveedor_id'), ''),
            'fecha_compra': m.get('fecha_compra'),
            'cantidad': cantidad,
            'cantidad_real': numero(m.get('cantidad_real')),
            'precio_unitario': costo,
            'factor_prestacional': None,
            'total_linea': (cantidad * costo) if (cantidad is not None and costo is not None) else None,
            'sin_precio': 'SI' if sin_precio(costo) else 'No',
            'marcado_revisar_siigo': 'Si' if viene_marcado_revisar(descripcion) else 'No',
        })
        filas.append(fila)

    for mo in detalle.get('manoObra') or []:
        nombre = (mo.get('nombre_snapshot') or '').strip() or f"Trabajador #{mo.get('trabajador_id')}"
        tarifa = numero(mo.get('tarifa_hora'))
        horas = numero(mo.get('horas_presupuestadas'))
        factor = numero(mo.get('factor_prestacional'))
        total = None
        if horas is not None and tarifa is not None:
            total = horas * tarifa * (factor if (mo.get('tipo') == 'Interno' and factor) else 1)
        fila = dict(base)
        fila.update({
            'tipo': 'Mano de obra',
            'linea_id': mo.get('id'),
            'descripcion': nombre,
            'clasificacion': mo.get('tipo'),  # Interno / Externo
            'forma_pago': '',
            'proveedor': '',
            'fecha_compra': None,
            'cantidad': horas,
            'cantidad_real': numero(mo.get('horas_reales')),
            'precio_unitario': tarifa,
            'factor_prestacional': factor,
            'total_linea': total,
            'sin_precio': 'SI' if sin_precio(tarifa) else 'No',
            'marcado_revisar_siigo': 'No',
        })
        filas.append(fila)

    return filas


def agrupar(filas, catalogo_por_norm):
    """Agrupa las filas de detalle por elemento distinto (tipo + descripcion normalizada)."""
    grupos = collections.OrderedDict()

    for f in filas:
        clave = (f['tipo'], normalizar(f['descripcion']))
        g = grupos.get(clave)
        if g is None:
            g = {
                'tipo': f['tipo'],
                'descripcion': re.sub(r'^\s*\[revisar\]\s*', '', f['descripcion'], flags=re.IGNORECASE),
                'cotizaciones': set(),
                'cantidad_total': 0.0,
                'fechas': [],
                'precios': [],
                'marcado_revisar_siigo': False,
            }
            grupos[clave] = g

        if f['cotizacion_numero']:
            g['cotizaciones'].add(f['cotizacion_numero'])
        if f['cantidad'] is not None:
            g['cantidad_total'] += f['cantidad']
        if f['fecha_cotizacion']:
            g['fechas'].append(f['fecha_cotizacion'])
        if f['precio_unitario'] is not None and f['precio_unitario'] > 0:
            g['precios'].append(f['precio_unitario'])
        if f['marcado_revisar_siigo'] == 'Si':
            g['marcado_revisar_siigo'] = True

    resultado = []
    for (tipo, norm), g in grupos.items():
        precios = g['precios']
        distintos = sorted(set(precios))
        # Referencia del catalogo maestro: SOLO si la descripcion coincide exacto.
        # Va en su propia columna, nunca reemplaza al precio real de las lineas.
        catalogo = catalogo_por_norm.get(norm) if tipo == 'Material' else None
        fechas = sorted(g['fechas'])
        resultado.append({
            'SIN_PRECIO': 'SI' if not precios else 'No',
            'NATURALEZA': clasificar_naturaleza(g['descripcion']) if tipo == 'Material' else 'SERVICIO / MANO DE OBRA',
            'tipo': tipo,
            'descripcion': g['descripcion'],
            'unidad': (catalogo or {}).get('unidad', ''),
            'n_cotizaciones': len(g['cotizaciones']),
            'cantidad_total': round(g['cantidad_total'], 2) if g['cantidad_total'] else None,
            'primera_fecha': fechas[0] if fechas else None,
            'ultima_fecha': fechas[-1] if fechas else None,
            'precio_actual_mas_usado': moda(precios),
            'precios_distintos': ' | '.join(f'{p:,.0f}' for p in distintos) if len(distintos) > 1 else '',
            'precio_catalogo': (catalogo or {}).get('mejor_precio'),
            'proveedor_catalogo': (catalogo or {}).get('mejor_proveedor_nombre') or '',
            'PRECIO_NUEVO': None,   # la llena el usuario a mano
            'NOTAS': None,          # la llena el usuario a mano
            'cotizaciones': lista_corta(g['cotizaciones']),
            'marcado_revisar_siigo': 'Si' if g['marcado_revisar_siigo'] else 'No',
        })

    # Sin precio primero; dentro de cada bloque, lo que aparece en mas
    # cotizaciones va arriba (mayor impacto al completarlo).
    orden_nat = {'Material': 0, 'GLOBAL (bolsa de varios)': 1, 'SERVICIO / MANO DE OBRA': 2}
    resultado.sort(key=lambda r: (r['SIN_PRECIO'] != 'SI', orden_nat.get(r['NATURALEZA'], 3),
                                  -r['n_cotizaciones'], r['descripcion'].lower()))
    return resultado


# ---------------------------------------------------------------- salidas

COLUMNAS_AGRUPADO = [
    'SIN_PRECIO', 'NATURALEZA', 'tipo', 'descripcion', 'unidad', 'n_cotizaciones', 'cantidad_total',
    'primera_fecha', 'ultima_fecha', 'precio_actual_mas_usado', 'precios_distintos',
    'precio_catalogo', 'proveedor_catalogo', 'PRECIO_NUEVO', 'NOTAS',
    'cotizaciones', 'marcado_revisar_siigo',
]

COLUMNAS_DETALLE = [
    'sin_precio', 'tipo', 'cotizacion_numero', 'cotizacion_id', 'linea_id', 'cliente',
    'estado', 'fecha_cotizacion', 'descripcion', 'clasificacion', 'forma_pago',
    'proveedor', 'fecha_compra', 'cantidad', 'cantidad_real', 'precio_unitario',
    'factor_prestacional', 'total_linea', 'origen_siigo',
]

ANCHOS_AGRUPADO = {
    'SIN_PRECIO': 11, 'NATURALEZA': 24, 'tipo': 13, 'descripcion': 52, 'unidad': 8, 'n_cotizaciones': 14,
    'cantidad_total': 14, 'primera_fecha': 13, 'ultima_fecha': 13,
    'precio_actual_mas_usado': 20, 'precios_distintos': 24, 'precio_catalogo': 16,
    'proveedor_catalogo': 26, 'PRECIO_NUEVO': 15, 'NOTAS': 30, 'cotizaciones': 40,
    'marcado_revisar_siigo': 14,
}

ANCHOS_DETALLE = {
    'descripcion': 46, 'cliente': 30, 'cotizacion_numero': 16, 'fecha_cotizacion': 15,
    'proveedor': 26, 'estado': 12, 'clasificacion': 13, 'forma_pago': 11,
    'precio_unitario': 15, 'total_linea': 15, 'sin_precio': 10, 'tipo': 13,
}


def escribir_csv(ruta, filas, separador):
    """CSV de la vista agrupada. UTF-8 con BOM para que Excel en espanol lo abra bien."""
    with open(ruta, 'w', newline='', encoding='utf-8-sig') as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNAS_AGRUPADO, delimiter=separador,
                                extrasaction='ignore')
        writer.writeheader()
        for f in filas:
            writer.writerow({k: ('' if f.get(k) is None else f.get(k)) for k in COLUMNAS_AGRUPADO})


def escribir_excel(ruta, agrupado, detalle):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    NEGRITA = Font(bold=True, color='FFFFFF')
    FONDO_ENCABEZADO = PatternFill('solid', fgColor='1F4E79')
    FONDO_SIN_PRECIO = PatternFill('solid', fgColor='FFC7CE')   # rojo claro
    FONDO_PARA_LLENAR = PatternFill('solid', fgColor='FFF2CC')  # amarillo claro
    FORMATO_PESOS = '#,##0'

    wb = Workbook()

    def encabezar(ws, columnas, anchos):
        ws.append(columnas)
        for i, col in enumerate(columnas, start=1):
            celda = ws.cell(row=1, column=i)
            celda.font = NEGRITA
            celda.fill = FONDO_ENCABEZADO
            celda.alignment = Alignment(vertical='center')
            ws.column_dimensions[get_column_letter(i)].width = anchos.get(col, 14)
        ws.freeze_panes = 'A2'

    # ---- Hoja 1: Para completar ----
    ws = wb.active
    ws.title = 'Para completar'
    encabezar(ws, COLUMNAS_AGRUPADO, ANCHOS_AGRUPADO)

    col_precio_nuevo = COLUMNAS_AGRUPADO.index('PRECIO_NUEVO') + 1
    columnas_pesos = {COLUMNAS_AGRUPADO.index(c) + 1 for c in
                      ('precio_actual_mas_usado', 'precio_catalogo', 'PRECIO_NUEVO')}

    for fila in agrupado:
        ws.append([fila.get(c) for c in COLUMNAS_AGRUPADO])
        n = ws.max_row
        if fila['SIN_PRECIO'] == 'SI':
            for i in range(1, len(COLUMNAS_AGRUPADO) + 1):
                ws.cell(row=n, column=i).fill = FONDO_SIN_PRECIO
        ws.cell(row=n, column=col_precio_nuevo).fill = FONDO_PARA_LLENAR
        for i in columnas_pesos:
            ws.cell(row=n, column=i).number_format = FORMATO_PESOS
    ws.auto_filter.ref = ws.dimensions

    # ---- Hoja 2: Detalle ----
    ws2 = wb.create_sheet('Detalle')
    encabezar(ws2, COLUMNAS_DETALLE, ANCHOS_DETALLE)

    columnas_pesos_detalle = {COLUMNAS_DETALLE.index(c) + 1 for c in
                              ('precio_unitario', 'total_linea')}
    for fila in detalle:
        ws2.append([fila.get(c) for c in COLUMNAS_DETALLE])
        n = ws2.max_row
        if fila['sin_precio'] == 'SI':
            for i in range(1, len(COLUMNAS_DETALLE) + 1):
                ws2.cell(row=n, column=i).fill = FONDO_SIN_PRECIO
        for i in columnas_pesos_detalle:
            ws2.cell(row=n, column=i).number_format = FORMATO_PESOS
    ws2.auto_filter.ref = ws2.dimensions

    wb.save(ruta)


# ---------------------------------------------------------------- principal

def main():
    cfg = parsear_argumentos(sys.argv[1:])
    usuario = os.environ.get('ADMIN_USERNAME')
    clave = os.environ.get('ADMIN_PASSWORD')
    if not usuario or not clave:
        print('Faltan credenciales. Define ADMIN_USERNAME y ADMIN_PASSWORD como '
              'variables de entorno antes de correr este script.', file=sys.stderr)
        sys.exit(1)

    # Se comprueba ANTES de descargar nada: leer todas las cotizaciones toma
    # varios minutos y seria absurdo descubrir al final que falta la libreria.
    try:
        import openpyxl  # noqa: F401
    except ImportError:
        print('Falta la libreria openpyxl (necesaria para generar el Excel). '
              'Instalala con:\n    pip install openpyxl', file=sys.stderr)
        sys.exit(1)

    api = ClienteApi(cfg['base_url'])
    print(f"Conectando a {cfg['base_url']} ...")
    api.login(usuario, clave)
    print('Sesion iniciada correctamente.')

    proveedores = {p['id']: p.get('nombre', '') for p in (api.get('/api/proveedores?todos=1') or [])}
    print(f'Proveedores: {len(proveedores)}.')

    catalogo = api.get('/api/materiales?todos=1') or []
    catalogo_por_norm = {normalizar(m.get('descripcion')): m for m in catalogo}
    print(f'Catalogo maestro de materiales: {len(catalogo)}.')

    lista = api.get('/api/cotizaciones') or []
    objetivo = lista
    if cfg['id_desde'] is not None:
        objetivo = [r for r in objetivo if r['id'] >= cfg['id_desde']]
    if cfg['id_hasta'] is not None:
        objetivo = [r for r in objetivo if r['id'] <= cfg['id_hasta']]
    if cfg['desde']:
        objetivo = [r for r in objetivo if (r.get('fecha_cotizacion') or '') >= cfg['desde']]
    if cfg['hasta']:
        objetivo = [r for r in objetivo if (r.get('fecha_cotizacion') or '') <= cfg['hasta']]
    if cfg['estados']:
        objetivo = [r for r in objetivo if r.get('estado') in cfg['estados']]

    total = len(objetivo)
    print(f'Analizando {total} de {len(lista)} cotizaciones (segun filtros aplicados)...')

    detalle = []
    errores = []
    for i, resumen in enumerate(objetivo, start=1):
        try:
            datos = api.get(f"/api/cotizaciones/{resumen['id']}")
        except RuntimeError as e:
            errores.append({'id': resumen['id'], 'numero': resumen.get('numero'), 'error': str(e)})
            continue
        detalle.extend(filas_de_cotizacion(datos, resumen, proveedores))
        if i % 10 == 0 or i == total:
            print(f'  {i}/{total} cotizaciones leidas...', end='\r', flush=True)
    print()

    detalle.sort(key=lambda f: (f['sin_precio'] != 'SI', f['tipo'],
                                str(f['cotizacion_numero'] or ''), f['descripcion'].lower()))
    agrupado = agrupar(detalle, catalogo_por_norm)

    carpeta = Path(__file__).resolve().parent.parent / 'reportes'
    carpeta.mkdir(exist_ok=True)
    marca = datetime.now().strftime('%Y%m%d-%H%M%S')
    ruta_csv = carpeta / f'elementos-cotizados-{marca}.csv'
    ruta_xlsx = carpeta / f'elementos-cotizados-{marca}.xlsx'

    escribir_csv(ruta_csv, agrupado, cfg['sep'])
    escribir_excel(ruta_xlsx, agrupado, detalle)

    sin_precio_agrupado = [g for g in agrupado if g['SIN_PRECIO'] == 'SI']
    sin_precio_detalle = [f for f in detalle if f['sin_precio'] == 'SI']
    materiales = [f for f in detalle if f['tipo'] == 'Material']

    print('\nListo.')
    print(f'  CSV   : {ruta_csv}')
    print(f'  Excel : {ruta_xlsx}')
    print(f'\nCotizaciones analizadas: {total}')
    print(f'Lineas revisadas: {len(detalle)} ({len(materiales)} materiales, '
          f'{len(detalle) - len(materiales)} de mano de obra)')
    print(f'Elementos distintos: {len(agrupado)}')
    print(f'Elementos distintos SIN PRECIO (van primero en la lista): {len(sin_precio_agrupado)}')
    print(f'Lineas afectadas por esos elementos sin precio: {len(sin_precio_detalle)}')
    if errores:
        print(f'\nATENCION: no se pudieron leer {len(errores)} cotizacion(es):')
        for e in errores[:10]:
            print(f"  - #{e['id']} {e['numero']}: {e['error']}")
        if len(errores) > 10:
            print(f'  ... y {len(errores) - 10} mas.')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        print(f'\nERROR: {e}', file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print('\nCancelado por el usuario.', file=sys.stderr)
        sys.exit(130)
