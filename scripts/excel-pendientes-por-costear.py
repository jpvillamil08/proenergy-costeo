#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Excel de trabajo con lo que FALTA por costear, separado en tres hojas segun
quien lo puede resolver:

  1. Materiales   -> se pueden buscar en listas de proveedor o cotizar.
  2. Servicios    -> mano de obra, alquiler de equipo y gestiones ante el
                     operador de red. No estan en ningun catalogo: salen de las
                     tarifas de PROENERGY.
  3. Codigos Siigo-> lineas donde en Siigo no quedo descripcion, solo el codigo
                     del item (P-000, P127...). Sin saber que producto es no hay
                     nada que buscar.

Cada hoja va ordenada por impacto (en cuantas cotizaciones aparece el elemento),
y la columna PRECIO_NUEVO queda vacia para llenarla a mano. Los elementos que se
repiten escritos de forma distinta se listan por separado, pero se marcan con un
GRUPO comun para poder darles el mismo precio de una vez.

Uso:
    $env:ADMIN_USERNAME = "admin"
    $env:ADMIN_PASSWORD = "tu-clave"
    python scripts/excel-pendientes-por-costear.py <URL>
"""

import importlib.util
import os
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location(
    'inventario', Path(__file__).resolve().parent / 'listar-elementos-cotizados.py')
inv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inv)

ES_CODIGO = re.compile(r'^\s*[A-Z]{1,2}-?\d+\s*$', re.IGNORECASE)


def norm(s):
    s = unicodedata.normalize('NFD', str(s or ''))
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'\s+', ' ', s.upper()).strip()


# Familias para agrupar variantes de escritura del mismo concepto. La idea no es
# adivinar el precio, sino que quien llene el Excel vea juntas las que son lo
# mismo y les ponga el mismo valor.
GRUPOS = [
    ('CARROCANASTA', ['CARROCANASTA']),
    ('APERTURA Y CIERRE CAJA CORTACIRCUITO', ['APERTURA Y CIERRE', 'APERTURA Y/O CIERRE']),
    ('RETIRO/INSTALACION MEDIDA INDIRECTA', ['MEDIDA INDI RECTA', 'MEDIDA INDIRECTA']),
    ('RETIRO/INSTALACION MEDIDA DIRECTA', ['MEDIDA DIRECTA']),
    ('TRANSFORMADOR DE CORRIENTE', ['TRANSFORMADOR DE CORRIENTE', 'TRANSFORMADORES DE CORRIENTE',
                                    'TCS TIPO VENTANA', 'TCS TIPO']),
    ('TRANSFORMADOR DE TENSION', ['TRANSFORMADOR DE TENSION', 'TRANSFORMADORES DE TENSION',
                                  'TRANSFORMADOR DE POTENCIA']),
    ('COLLARIN / ABRAZADERA POSTE', ['COLLARIN', 'ABRASADERA', 'ABRAZADERA']),
    ('CONECTOR AMPACT', ['CONECTOR AMPACT', 'CONECTOR AMPAC']),
    ('FUSIBLE DE HILO', ['FUSIBLE DE HILO']),
    ('TERMINAL PONCHABLE', ['TERMINAL PONCHABLE']),
    ('PERNO / TORNILLO 5/8', ['PERNO ESPARRAGO', 'TORNILLO 5/8', 'ESPARRAGO']),
    ('HERRAJE SOPORTE EN L', ['HERRAJES CORTO PARA SOPORTE']),
    ('EMT (uniones, curvas, conectores)', ['UNIONES EMT', 'CURVA EMT', 'CONECTOR EMT']),
    ('CONECTOR / CORAZA LT', ['CONECTOR LT', 'CONECTOR PARA CORAZA']),
    ('GESTION ANTE OPERADOR DE RED', ['GESTION DESCARGO', 'GESTION ANTE OPERADOR']),
    ('PREMOLDEADOS 17KV', ['JUEGO PREMOLDEADOS']),
]


def grupo_de(descripcion):
    n = norm(descripcion)
    for etiqueta, claves in GRUPOS:
        if any(k in n for k in claves):
            return etiqueta
    return ''


COLUMNAS = ['PRECIO_NUEVO', 'NOTAS', 'GRUPO', 'descripcion', 'n_cotizaciones',
            'cantidad_total', 'unidad', 'primera_fecha', 'ultima_fecha', 'cotizaciones']
ANCHOS = {'PRECIO_NUEVO': 15, 'NOTAS': 26, 'GRUPO': 34, 'descripcion': 72,
          'n_cotizaciones': 9, 'cantidad_total': 11, 'unidad': 8,
          'primera_fecha': 12, 'ultima_fecha': 12, 'cotizaciones': 40}


def main():
    cfg = inv.parsear_argumentos(sys.argv[1:])
    usuario, clave = os.environ.get('ADMIN_USERNAME'), os.environ.get('ADMIN_PASSWORD')
    if not usuario or not clave:
        print('Faltan ADMIN_USERNAME / ADMIN_PASSWORD.', file=sys.stderr)
        sys.exit(1)

    api = inv.ClienteApi(cfg['base_url'])
    api.login(usuario, clave)
    print('Sesion iniciada. Leyendo cotizaciones...')

    proveedores = {p['id']: p.get('nombre', '') for p in (api.get('/api/proveedores?todos=1') or [])}
    catalogo = {inv.normalizar(m.get('descripcion')): m for m in (api.get('/api/materiales?todos=1') or [])}
    lista = api.get('/api/cotizaciones') or []
    detalle = []
    for i, r in enumerate(lista, 1):
        try:
            detalle.extend(inv.filas_de_cotizacion(api.get(f"/api/cotizaciones/{r['id']}"), r, proveedores))
        except RuntimeError:
            pass
        if i % 25 == 0 or i == len(lista):
            print(f'  {i}/{len(lista)}...', end='\r', flush=True)
    print()

    agrupado = inv.agrupar(detalle, catalogo)
    sin = [g for g in agrupado if g['SIN_PRECIO'] == 'SI']

    materiales, servicios, codigos = [], [], []
    for g in sin:
        fila = {
            'PRECIO_NUEVO': None, 'NOTAS': None, 'GRUPO': grupo_de(g['descripcion']),
            'descripcion': g['descripcion'], 'n_cotizaciones': g['n_cotizaciones'],
            'cantidad_total': g['cantidad_total'], 'unidad': g['unidad'],
            'primera_fecha': g['primera_fecha'], 'ultima_fecha': g['ultima_fecha'],
            'cotizaciones': g['cotizaciones'],
        }
        if ES_CODIGO.match(g['descripcion']):
            codigos.append(fila)
        elif 'SERVICIO' in g['NATURALEZA'] or g['NATURALEZA'].startswith('GLOBAL'):
            servicios.append(fila)
        else:
            materiales.append(fila)

    # Primero lo que mas se repite; dentro de un mismo grupo, juntas.
    for lote in (materiales, servicios, codigos):
        lote.sort(key=lambda r: (r['GRUPO'] == '', r['GRUPO'], -r['n_cotizaciones'],
                                 r['descripcion'].lower()))

    escribir(materiales, servicios, codigos)


def escribir(materiales, servicios, codigos):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    carpeta = RAIZ / 'reportes'
    carpeta.mkdir(exist_ok=True)
    ruta = carpeta / f"pendientes-por-costear-{datetime.now().strftime('%Y%m%d-%H%M%S')}.xlsx"

    wb = Workbook()
    LLENAR = PatternFill('solid', fgColor='FFF2CC')
    ALTERNO = PatternFill('solid', fgColor='F2F2F2')

    hojas = [
        ('1. Materiales', materiales,
         'Se pueden buscar en listas de proveedor o cotizar. Llene PRECIO_NUEVO.'),
        ('2. Servicios y mano de obra', servicios,
         'No estan en ningun catalogo: son tarifas de PROENERGY (mano de obra, alquiler de equipo, gestiones).'),
        ('3. Solo codigo de Siigo', codigos,
         'En Siigo no quedo descripcion, solo el codigo del item. Hace falta saber que producto es cada uno.'),
    ]
    primera = True
    for titulo, filas, nota in hojas:
        ws = wb.active if primera else wb.create_sheet()
        ws.title = titulo
        primera = False
        ws['A1'] = f'{nota}   ({len(filas)} elementos, {sum(f["n_cotizaciones"] for f in filas)} lineas de cotizacion)'
        ws['A1'].font = Font(bold=True, size=11)
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(COLUMNAS))
        ws.append(COLUMNAS)
        for i, c in enumerate(COLUMNAS, 1):
            cel = ws.cell(row=2, column=i)
            cel.font = Font(bold=True, color='FFFFFF')
            cel.fill = PatternFill('solid', fgColor='1F4E79')
            cel.alignment = Alignment(vertical='center')
            ws.column_dimensions[get_column_letter(i)].width = ANCHOS.get(c, 14)
        ws.freeze_panes = 'C3'
        grupo_prev, alterna = None, False
        for f in filas:
            ws.append([f.get(c) for c in COLUMNAS])
            n = ws.max_row
            # Sombrea alternando por grupo, para que las variantes del mismo
            # concepto se vean juntas de un vistazo.
            if f['GRUPO'] != grupo_prev:
                alterna = not alterna
                grupo_prev = f['GRUPO']
            if alterna and f['GRUPO']:
                for i in range(3, len(COLUMNAS) + 1):
                    ws.cell(row=n, column=i).fill = ALTERNO
            ws.cell(row=n, column=1).fill = LLENAR
            ws.cell(row=n, column=2).fill = LLENAR
            ws.cell(row=n, column=1).number_format = '#,##0'
        ws.auto_filter.ref = f'A2:{get_column_letter(len(COLUMNAS))}{ws.max_row}'

    wb.save(ruta)
    print(f'\nExcel: {ruta}')
    for titulo, filas, _ in hojas:
        print(f'  {titulo:32} {len(filas):4} elementos | {sum(f["n_cotizaciones"] for f in filas):4} lineas')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        print(f'\nERROR: {e}', file=sys.stderr)
        sys.exit(1)
