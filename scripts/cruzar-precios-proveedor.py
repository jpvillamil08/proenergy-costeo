#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cruza los materiales SIN PRECIO de las cotizaciones contra el catalogo de
precios del proveedor (el que arma catalogo-proveedor-felixtorres.py) y genera
un Excel de trabajo con los precios candidatos y su evidencia.

PROPONE, NO IMPONE. La columna PRECIO_NUEVO queda vacia: lo que el script
aporta es PRECIO_SUGERIDO + CONFIANZA + de que archivo y que referencia salio,
para que una persona confirme. Nunca se escribe un precio en la aplicacion
desde aqui.

Por que tanto cuidado: en material electrico la medida es el producto. Un
"CABLE CU N.2 DESNUDO" y un "CABLE CU N.4 DESNUDO" son cosas distintas con
precios muy distintos, y sus descripciones se parecen en un 90%. Por eso el
cruce EXIGE que las medidas (calibres, diametros, tensiones) coincidan, y
descarta el candidato cuando hay empate entre varios.

Uso:
    $env:ADMIN_USERNAME = "admin"
    $env:ADMIN_PASSWORD = "tu-clave"
    python scripts/cruzar-precios-proveedor.py <URL_DE_LA_APP>
"""

import json
import os
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CATALOGO = RAIZ / 'reportes' / 'catalogo-felixtorres.json'

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Reutiliza el cliente y los parsers del script de inventario, cargandolo por
# ruta porque su nombre lleva guiones y no es importable como modulo normal.
import importlib.util
_spec = importlib.util.spec_from_file_location(
    'inventario', Path(__file__).resolve().parent / 'listar-elementos-cotizados.py')
inventario = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inventario)


# ------------------------------------------------------------------ texto

STOPWORDS = {
    'para', 'con', 'sin', 'del', 'las', 'los', 'una', 'uno', 'por', 'que',
    'incluye', 'tipo', 'und', 'unidad', 'mts', 'mt', 'metro', 'metros',
    'referencia', 'ref', 'marca', 'color', 'general', 'generales',
}


def normalizar(texto):
    s = unicodedata.normalize('NFD', str(texto or ''))
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = s.lower().replace('[revisar]', '')
    s = s.replace('"', ' pulg ').replace('”', ' pulg ').replace('°', ' n ').replace('º', ' n ')
    s = re.sub(r'[^a-z0-9/.\-\s]', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def tokens(texto):
    t = [p for p in normalizar(texto).split() if len(p) >= 3 and p not in STOPWORDS]
    return set(t)


# Medidas: lo que hace que dos productos parecidos sean productos distintos.
# Calibres (2 awg, n 2, #12), fracciones de pulgada (1/2, 3/4), tensiones
# (15kv, 13.2kv), secciones (3x8), y numeros sueltos significativos.
RE_FRACCION = re.compile(r'\b(\d{1,2}\s*/\s*\d{1,2})\b')
RE_SECCION = re.compile(r'\b(\d{1,2}\s*x\s*\d{1,3})\b')
RE_TENSION = re.compile(r'\b(\d{1,3}(?:[.,]\d)?)\s*k\s*v\b')
RE_CALIBRE = re.compile(r'(?:\bn\s*|#\s*|\bcal\s*|\bcalibre\s*)(\d{1,3}/?\d?)\b')
RE_AWG = re.compile(r'\b(\d{1,3}/?\d?)\s*awg\b')
RE_NUM = re.compile(r'\b(\d{1,4}(?:[.,]\d{1,2})?)\b')


def medidas(texto):
    s = normalizar(texto)
    m = set()
    for rx, etq in ((RE_FRACCION, 'fr'), (RE_SECCION, 'sx'), (RE_TENSION, 'kv'),
                    (RE_CALIBRE, 'cal'), (RE_AWG, 'awg')):
        for g in rx.findall(s):
            m.add(f'{etq}:{re.sub(chr(32), "", g).replace(",", ".")}')
    return m


def numeros(texto):
    s = normalizar(texto)
    # Se ignoran numeros que son claramente empaque/anio
    return {n.replace(',', '.') for n in RE_NUM.findall(s) if not re.fullmatch(r'(19|20)\d{2}', n)}


# ------------------------------------------------------------------ categoria

# El tipo de producto. Sin esto el cruce confunde cosas que comparten medida:
# un "TERMINAL DE OJO #12 AWG AMARILLO" cruzaba contra un "CABLE NO-HALOGENADO
# 12 AWG AMARILLO" solo porque comparten "12 awg" y "amarillo", y un terminal
# no es un cable. Cada familia agrupa los sinonimos que usan los catalogos.
FAMILIAS = {
    'cable': {'cable', 'cables', 'alambre', 'conductor', 'encauchetado', 'cordon'},
    'terminal': {'terminal', 'terminales', 'ponchable', 'barril'},
    'conector': {'conector', 'conectores', 'ampact', 'cuna', 'miniwedge', 'empalme'},
    'grapa': {'grapa', 'grapas', 'abrazadera'},
    'caja': {'caja', 'cajas', 'gabinete', 'cofre', 'tablero'},
    'coraza': {'coraza', 'corazas', 'flexible'},
    'tubo': {'tubo', 'tuberia', 'conduit', 'emt', 'imc', 'ducto'},
    'varilla': {'varilla', 'barrilla', 'barra', 'electrodo'},
    'hebilla': {'hebilla', 'hebillas'},
    'cinta': {'cinta', 'cintas', 'bandit', 'bandix'},
    'breaker': {'breaker', 'interruptor', 'totalizador', 'automatico'},
    'dps': {'dps', 'descargador', 'descargadores', 'pararrayo', 'sobretension'},
    'poste': {'poste', 'postes'},
    'cruceta': {'cruceta', 'crucetas'},
    'aislador': {'aislador', 'aisladores', 'aislante'},
    'transformador': {'transformador', 'transformadores'},
    'medidor': {'medidor', 'medidores', 'contador'},
    'cortacircuito': {'cortacircuito', 'cortacircuitos', 'cortacirucito', 'fusible', 'portafusible'},
    'platina': {'platina', 'platinas', 'riel', 'chanel', 'perfil'},
    'tornillo': {'tornillo', 'tornillos', 'perno', 'pernos', 'tuerca', 'arandela'},
    'prensa': {'prensa', 'estopa', 'racor'},
    'bandeja': {'bandeja', 'bandejas', 'escalerilla'},
    'luminaria': {'luminaria', 'lampara', 'bombillo', 'reflector', 'led'},
}
# Palabras que delatan una fila que no es un producto sino una nota o un
# encabezado partido por el parser ("Hasta cable desnudo 2/0 AWG").
RUIDO_INICIAL = ('hasta', 'desde', 'nota', 'observ', 'total', 'subtotal', 'aplica', 'incluye')


def familias(texto):
    t = set(normalizar(texto).split())
    return {fam for fam, palabras in FAMILIAS.items() if t & palabras}


def descripcion_util(texto):
    """Descarta descripciones que no identifican un producto."""
    s = normalizar(texto)
    if len(s) < 8:
        return False
    if s.startswith(RUIDO_INICIAL):
        return False
    # Solo medidas y unidades, sin ningun sustantivo (ej: "4/0 awg", "1/0 awg")
    letras = [p for p in s.split() if re.fullmatch(r'[a-z]{3,}', p)]
    if not letras or set(letras) <= {'awg', 'mts', 'pulg', 'und', 'kcmil'}:
        return False
    return True


def precio_parece_codigo(precio, referencia):
    """Un codigo de producto colado en la columna de precio.

    Caso real de estas listas: 'CAJA RAWELT 2x4 3 SALIDAS' devolvia 4.001.031,
    que es el codigo interno, no el precio. Se detecta porque el numero coincide
    con la referencia, o porque es un entero enorme sin decimales tipo 4xxxxxx.
    """
    if referencia:
        solo_digitos = re.sub(r'\D', '', str(referencia))
        if solo_digitos and solo_digitos == str(int(precio)):
            return True
    if precio >= 1_000_000 and float(precio).is_integer() and len(str(int(precio))) >= 7:
        return True
    return False


# ------------------------------------------------------------------ cruce

def puntuar(mat_tok, mat_med, mat_num, mat_fam, cand):
    """Devuelve (score, motivo) o (0, razon) si no es aceptable."""
    comunes = mat_tok & cand['tok']
    if not comunes:
        return 0, 'sin palabras en comun'

    # Reglas duras: descartan el candidato sin importar cuanto se parezca.
    if not cand['util']:
        return 0, 'la fila del catalogo no identifica un producto'
    if cand['codigo']:
        return 0, 'el precio parece un codigo de producto'
    if mat_fam and cand['fam'] and not (mat_fam & cand['fam']):
        return 0, 'son tipos de producto distintos'
    # Cobertura: que parte de la descripcion del material esta en el candidato
    cobertura = len(comunes) / max(len(mat_tok), 1)
    # Y que parte del candidato usa el material (evita que un texto larguisimo
    # del catalogo gane solo por tener muchas palabras)
    cobertura_inv = len(comunes) / max(len(cand['tok']), 1)

    # Regla dura: si ambos declaran medidas y no comparten ninguna, se descarta.
    if mat_med and cand['med'] and not (mat_med & cand['med']):
        return 0, 'las medidas no coinciden'
    # Si el material declara medidas y el candidato ninguna, es sospechoso
    penalizacion = 0.15 if (mat_med and not cand['med']) else 0.0
    bono_med = 0.25 if (mat_med and (mat_med & cand['med'])) else 0.0
    # Numeros compartidos ayudan (calibres escritos de otra forma)
    bono_num = 0.10 if (mat_num & cand['num']) else 0.0
    bono_fam = 0.20 if (mat_fam and (mat_fam & cand['fam'])) else 0.0

    score = (0.55 * cobertura + 0.25 * cobertura_inv + bono_med + bono_num + bono_fam) - penalizacion
    return round(min(score, 1.0), 4), f'{len(comunes)} palabras en comun'


def clasificar(score, empate, medidas_ok, familia_ok):
    # ALTA exige las tres cosas: buen parecido textual, medidas compatibles
    # y el mismo tipo de producto. Sin familia coincidente no pasa de MEDIA.
    if score >= 0.75 and not empate and medidas_ok and familia_ok:
        return 'ALTA'
    if score >= 0.60 and not empate and familia_ok:
        return 'MEDIA'
    if score >= 0.45:
        return 'BAJA'
    return None


def main():
    if not CATALOGO.exists():
        print(f'Falta el catalogo del proveedor: {CATALOGO}\n'
              f'Corre primero: python scripts/catalogo-proveedor-felixtorres.py', file=sys.stderr)
        sys.exit(1)

    cfg = inventario.parsear_argumentos(sys.argv[1:])
    usuario = os.environ.get('ADMIN_USERNAME')
    clave = os.environ.get('ADMIN_PASSWORD')
    if not usuario or not clave:
        print('Faltan ADMIN_USERNAME / ADMIN_PASSWORD.', file=sys.stderr)
        sys.exit(1)

    print('Cargando catalogo del proveedor...')
    datos = json.loads(CATALOGO.read_text(encoding='utf-8'))
    crudos = datos['items']

    # Una misma referencia aparece en varias listas (precio, presupuesto, promo).
    # Se agrupa por descripcion normalizada y se conserva el precio MAS BAJO,
    # que es el criterio que ya usa la app al elegir proveedor (mejor_precio).
    porclave = {}
    for it in crudos:
        clave_cat = normalizar(it['descripcion'])
        if len(clave_cat) < 4:
            continue
        prev = porclave.get(clave_cat)
        if prev is None or it['precio'] < prev['precio']:
            porclave[clave_cat] = it
    candidatos = []
    for it in porclave.values():
        candidatos.append({
            'descripcion': it['descripcion'],
            'precio': it['precio'],
            'referencia': it.get('referencia', ''),
            'marca': it.get('marca', ''),
            'origen': it.get('origen', ''),
            'tok': tokens(it['descripcion']),
            'med': medidas(it['descripcion']),
            'num': numeros(it['descripcion']),
            'fam': familias(it['descripcion']),
            'util': descripcion_util(it['descripcion']),
            'codigo': precio_parece_codigo(it['precio'], it.get('referencia', '')),
        })
    print(f'Referencias unicas en el catalogo: {len(candidatos):,} (de {len(crudos):,} filas)')

    # Indice invertido por palabra, para no comparar todo contra todo
    indice = defaultdict(list)
    for i, c in enumerate(candidatos):
        for t in c['tok']:
            indice[t].append(i)

    print('\nLeyendo los materiales de la app...')
    api = inventario.ClienteApi(cfg['base_url'])
    api.login(usuario, clave)
    proveedores = {p['id']: p.get('nombre', '') for p in (api.get('/api/proveedores?todos=1') or [])}
    catalogo_app = api.get('/api/materiales?todos=1') or []
    catalogo_por_norm = {inventario.normalizar(m.get('descripcion')): m for m in catalogo_app}
    lista = api.get('/api/cotizaciones') or []
    detalle = []
    for i, resumen in enumerate(lista, 1):
        try:
            detalle.extend(inventario.filas_de_cotizacion(
                api.get(f"/api/cotizaciones/{resumen['id']}"), resumen, proveedores))
        except RuntimeError:
            pass
        if i % 25 == 0 or i == len(lista):
            print(f'  {i}/{len(lista)} cotizaciones...', end='\r', flush=True)
    print()
    agrupado = inventario.agrupar(detalle, catalogo_por_norm)
    sin_precio = [g for g in agrupado if g['SIN_PRECIO'] == 'SI']
    print(f'Elementos sin precio a cruzar: {len(sin_precio)}')

    print('\nCruzando...')
    resumen_conf = defaultdict(int)
    for g in sin_precio:
        mt = tokens(g['descripcion'])
        mm = medidas(g['descripcion'])
        mn = numeros(g['descripcion'])
        mf = familias(g['descripcion'])
        vistos = set()
        for t in mt:
            vistos.update(indice.get(t, ()))
        puntuados = []
        for i in vistos:
            s, _ = puntuar(mt, mm, mn, mf, candidatos[i])
            if s > 0:
                puntuados.append((s, i))
        puntuados.sort(reverse=True)

        g['PRECIO_SUGERIDO'] = None
        g['CONFIANZA'] = ''
        g['CATALOGO_DESCRIPCION'] = ''
        g['CATALOGO_REFERENCIA'] = ''
        g['CATALOGO_MARCA'] = ''
        g['CATALOGO_ARCHIVO'] = ''
        g['OTRO_CANDIDATO'] = ''

        if not puntuados:
            resumen_conf['sin candidato'] += 1
            continue
        mejor_s, mejor_i = puntuados[0]
        c = candidatos[mejor_i]
        # Empate = varios candidatos casi igual de buenos con precios distintos
        cercanos = [i for s, i in puntuados[1:6] if mejor_s - s < 0.06]
        empate = any(candidatos[i]['precio'] != c['precio'] for i in cercanos)
        conf = clasificar(mejor_s, empate,
                          bool(mm and (mm & c['med'])) or not mm,
                          bool(mf and (mf & c['fam'])))
        if conf is None:
            resumen_conf['descartado (score bajo)'] += 1
            continue
        resumen_conf[conf] += 1
        g['PRECIO_SUGERIDO'] = c['precio']
        g['CONFIANZA'] = conf
        g['CATALOGO_DESCRIPCION'] = c['descripcion']
        g['CATALOGO_REFERENCIA'] = c['referencia']
        g['CATALOGO_MARCA'] = c['marca']
        g['CATALOGO_ARCHIVO'] = c['origen']
        if cercanos:
            o = candidatos[cercanos[0]]
            g['OTRO_CANDIDATO'] = f'{o["descripcion"][:60]} = {o["precio"]:,.0f}'

    for g in agrupado:
        g.setdefault('PRECIO_SUGERIDO', None)
        g.setdefault('CONFIANZA', '')
        for k in ('CATALOGO_DESCRIPCION', 'CATALOGO_REFERENCIA', 'CATALOGO_MARCA',
                  'CATALOGO_ARCHIVO', 'OTRO_CANDIDATO'):
            g.setdefault(k, '')

    # Orden: primero lo que hay que revisar y tiene sugerencia, por confianza y
    # por cuantas cotizaciones afecta.
    ORDEN_CONF = {'ALTA': 0, 'MEDIA': 1, 'BAJA': 2, '': 3}
    agrupado.sort(key=lambda r: (r['SIN_PRECIO'] != 'SI',
                                 ORDEN_CONF.get(r['CONFIANZA'], 3),
                                 -r['n_cotizaciones']))

    escribir(agrupado, detalle, resumen_conf, len(sin_precio))


COLUMNAS = [
    'SIN_PRECIO', 'CONFIANZA', 'descripcion', 'n_cotizaciones', 'cantidad_total',
    'PRECIO_SUGERIDO', 'PRECIO_NUEVO', 'CATALOGO_DESCRIPCION', 'CATALOGO_REFERENCIA',
    'CATALOGO_MARCA', 'CATALOGO_ARCHIVO', 'OTRO_CANDIDATO', 'NOTAS',
    'unidad', 'primera_fecha', 'ultima_fecha', 'precio_actual_mas_usado',
    'precio_catalogo', 'cotizaciones', 'marcado_revisar_siigo',
]
ANCHOS = {
    'SIN_PRECIO': 11, 'CONFIANZA': 11, 'descripcion': 50, 'n_cotizaciones': 8,
    'cantidad_total': 12, 'PRECIO_SUGERIDO': 16, 'PRECIO_NUEVO': 15,
    'CATALOGO_DESCRIPCION': 46, 'CATALOGO_REFERENCIA': 16, 'CATALOGO_MARCA': 22,
    'CATALOGO_ARCHIVO': 38, 'OTRO_CANDIDATO': 42, 'NOTAS': 24, 'unidad': 8,
    'primera_fecha': 12, 'ultima_fecha': 12, 'precio_actual_mas_usado': 16,
    'precio_catalogo': 14, 'cotizaciones': 34, 'marcado_revisar_siigo': 12,
}


def escribir(agrupado, detalle, resumen_conf, total_sin_precio):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    carpeta = RAIZ / 'reportes'
    carpeta.mkdir(exist_ok=True)
    marca = datetime.now().strftime('%Y%m%d-%H%M%S')
    ruta_x = carpeta / f'elementos-con-precios-proveedor-{marca}.xlsx'
    ruta_c = carpeta / f'elementos-con-precios-proveedor-{marca}.csv'

    import csv
    with open(ruta_c, 'w', newline='', encoding='utf-8-sig') as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNAS, delimiter=';', extrasaction='ignore')
        w.writeheader()
        for g in agrupado:
            w.writerow({k: ('' if g.get(k) is None else g.get(k)) for k in COLUMNAS})

    wb = Workbook()
    ws = wb.active
    ws.title = 'Para completar'
    COLORES = {
        'ALTA': PatternFill('solid', fgColor='C6EFCE'),
        'MEDIA': PatternFill('solid', fgColor='FFEB9C'),
        'BAJA': PatternFill('solid', fgColor='FFD9B3'),
    }
    SIN = PatternFill('solid', fgColor='FFC7CE')
    LLENAR = PatternFill('solid', fgColor='FFF2CC')
    ws.append(COLUMNAS)
    for i, c in enumerate(COLUMNAS, 1):
        cel = ws.cell(row=1, column=i)
        cel.font = Font(bold=True, color='FFFFFF')
        cel.fill = PatternFill('solid', fgColor='1F4E79')
        cel.alignment = Alignment(vertical='center')
        ws.column_dimensions[get_column_letter(i)].width = ANCHOS.get(c, 14)
    ws.freeze_panes = 'C2'

    i_conf = COLUMNAS.index('CONFIANZA') + 1
    i_pn = COLUMNAS.index('PRECIO_NUEVO') + 1
    cols_pesos = {COLUMNAS.index(c) + 1 for c in
                  ('PRECIO_SUGERIDO', 'PRECIO_NUEVO', 'precio_actual_mas_usado', 'precio_catalogo')}
    for g in agrupado:
        ws.append([g.get(c) for c in COLUMNAS])
        n = ws.max_row
        if g['SIN_PRECIO'] == 'SI':
            ws.cell(row=n, column=1).fill = SIN
        f = COLORES.get(g.get('CONFIANZA'))
        if f:
            ws.cell(row=n, column=i_conf).fill = f
        ws.cell(row=n, column=i_pn).fill = LLENAR
        for c in cols_pesos:
            ws.cell(row=n, column=c).number_format = '#,##0'
    ws.auto_filter.ref = ws.dimensions

    ws2 = wb.create_sheet('Detalle')
    ws2.append(inventario.COLUMNAS_DETALLE)
    for i, c in enumerate(inventario.COLUMNAS_DETALLE, 1):
        cel = ws2.cell(row=1, column=i)
        cel.font = Font(bold=True, color='FFFFFF')
        cel.fill = PatternFill('solid', fgColor='1F4E79')
        ws2.column_dimensions[get_column_letter(i)].width = inventario.ANCHOS_DETALLE.get(c, 14)
    ws2.freeze_panes = 'A2'
    for f in detalle:
        ws2.append([f.get(c) for c in inventario.COLUMNAS_DETALLE])
    ws2.auto_filter.ref = ws2.dimensions
    wb.save(ruta_x)

    con_sug = sum(1 for g in agrupado if g.get('PRECIO_SUGERIDO'))
    print(f'\nExcel: {ruta_x}')
    print(f'CSV  : {ruta_c}')
    print(f'\nElementos sin precio            : {total_sin_precio}')
    print(f'Con precio sugerido del proveedor: {con_sug}')
    for k in ('ALTA', 'MEDIA', 'BAJA', 'descartado (score bajo)', 'sin candidato'):
        if resumen_conf.get(k):
            print(f'   {k:26}: {resumen_conf[k]}')
    print(f'Quedan sin ninguna pista        : {total_sin_precio - con_sug}')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        print(f'\nERROR: {e}', file=sys.stderr)
        sys.exit(1)
