#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Deja presentable el Excel de seguimiento de ofertas.

El archivo venia mezclando tipos de dato en la misma columna, que es lo que lo
hacia ilegible y ademas impedia sumar o filtrar:
  - importes como texto ("$19.265.673,00") junto a numeros (2068620.4)
  - fechas como texto ("2026-06-11") junto a fechas de verdad
  - porcentajes guardados como 0.24 sin formato
  - dos columnas vacias a la izquierda y el encabezado en la fila 2

Lo que hace:
  - convierte cada columna a su tipo real y le pone un formato uniforme
  - encabezado en la fila 1, congelado, con autofiltro
  - anchos calculados segun el contenido de cada columna
  - importes alineados a la derecha con separador de miles, fechas dd/mm/aaaa,
    porcentajes con un decimal
  - filas alternas sombreadas para poder seguir la linea con la vista
  - una columna ORIGEN que dice si la fila la escribio una persona o el sistema
  - fila de totales al final, congelada aparte
  - una segunda hoja con el resumen por mes y por tipo de actividad

Uso:
    python scripts/formatear-excel-ofertas.py "<ruta del excel lleno>"
"""

import re
import sys
import unicodedata
from datetime import date, datetime
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

# Orden y presentacion final de las columnas. El tipo decide el formato.
COLUMNAS = [
    ('OFERTA No',            'texto',   11),
    ('FECHA',                'fecha',   11),
    ('CLIENTE',              'texto',   30),
    ('ESTADO',               'texto',   11),
    ('CIUDAD',               'texto',   15),
    ('TIPO DE ACTIVIDAD',    'texto',   26),
    ('NOMBRE DEL PROYECTO',  'texto',   46),
    ('COSTO PROVEEDORES',    'dinero',  16),
    ('VIÁTICOS + GASOLINA',  'dinero',  16),
    ('MO PROENERGY',         'dinero',  15),
    ('IMPREVISTOS',          'dinero',  14),
    ('COSTO TOTAL',          'dinero',  16),
    ('PV (SIN IVA)',         'dinero',  16),
    ('UTILIDAD $',           'dinero',  16),
    ('UTILIDAD %',           'pct',     11),
    ('ANTICIPO %',           'pct',     11),
    ('PLAZO PAGO',           'entero',  11),
    ('TIEMPO EJEC.',         'entero',  11),
    ('N° FACTURA',           'texto',   16),
    ('ORDEN / OBSERV.',      'texto',   22),
    ('DIRECCION',            'texto',   22),
    ('VALIDEZ OFERTA',       'texto',   14),
    ('ORIGEN',               'texto',   11),
]

# De donde sale cada columna nueva en el archivo viejo
ORIGEN = {
    'OFERTA No': 'OFERTA NO', 'FECHA': 'FECHA DE ENVIO', 'CLIENTE': 'CLIENTE',
    'ESTADO': 'ESTADO', 'CIUDAD': 'CIUDAD', 'TIPO DE ACTIVIDAD': 'TIPO DE ACTIVIDAD',
    'NOMBRE DEL PROYECTO': 'NOMBRE DEL PROYECTO', 'COSTO PROVEEDORES': 'COSTO PROVEEDORES',
    'VIÁTICOS + GASOLINA': 'COSTO VIATICOS', 'MO PROENERGY': 'COSTO MO',
    'IMPREVISTOS': 'IMPREVISTOS', 'PV (SIN IVA)': 'PV (SIN IVA)',
    'UTILIDAD $': 'UTILIDAD $', 'UTILIDAD %': 'UTILIDAD %', 'ANTICIPO %': 'ANTICIPO',
    'PLAZO PAGO': 'PLAZO DE PAGO', 'TIEMPO EJEC.': 'TIEMPO DE EJECUCION',
    'N° FACTURA': 'NUMERO DE FACTURA', 'ORDEN / OBSERV.': 'OBSERVACIONES',
    'DIRECCION': 'DIRECCION', 'VALIDEZ OFERTA': 'PLAZO VALIDEZ',
}

AZUL = '1F4E79'
GRIS = 'F5F7FA'
VERDE = 'E8F5E9'
AMARILLO = 'FFF8E1'


def norm(s):
    s = unicodedata.normalize('NFD', str(s or ''))
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'\s+', ' ', s.upper()).strip()


def a_numero(v):
    """Acepta 12345, 12345.6 y "$19.265.673,00" y devuelve siempre un numero."""
    if v is None or v == '':
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace('$', '').replace(' ', '').replace('\xa0', '')
    if not s or not re.search(r'\d', s):
        return None
    # "19.265.673,00" -> miles con punto y decimales con coma
    if ',' in s and '.' in s:
        s = s.replace('.', '').replace(',', '.') if s.rfind(',') > s.rfind('.') else s.replace(',', '')
    elif ',' in s:
        partes = s.split(',')
        s = s.replace(',', '.') if len(partes[-1]) <= 2 else s.replace(',', '')
    elif s.count('.') > 1:
        s = s.replace('.', '')
    try:
        return float(s)
    except ValueError:
        return None


def a_fecha(v):
    if v is None or v == '':
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip()[:10]
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%d-%m-%Y'):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def main():
    if len(sys.argv) < 2:
        print('Uso: python scripts/formatear-excel-ofertas.py "<ruta del excel>"', file=sys.stderr)
        sys.exit(1)
    ruta = Path(sys.argv[1])
    if not ruta.exists():
        print(f'No existe: {ruta}', file=sys.stderr)
        sys.exit(1)

    origen = load_workbook(ruta)
    ws0 = origen[origen.sheetnames[0]]
    # El encabezado esta en la fila 2 del archivo viejo
    enc = {}
    for c in range(1, ws0.max_column + 1):
        v = ws0.cell(row=2, column=c).value
        if v:
            enc[norm(v)] = c

    def columna_de(nombre):
        n = norm(nombre)
        for k, v in enc.items():
            if k.startswith(n):
                return v
        return None

    mapa = {destino: columna_de(fuente) for destino, fuente in ORIGEN.items()}

    filas = []
    for r in range(3, ws0.max_row + 1):
        num = ws0.cell(row=r, column=mapa['OFERTA No']).value
        if not num:
            continue
        d = {}
        for destino, (_, tipo, _w) in ((c[0], c) for c in COLUMNAS):
            col = mapa.get(destino)
            v = ws0.cell(row=r, column=col).value if col else None
            if tipo in ('dinero', 'entero'):
                d[destino] = a_numero(v)
            elif tipo == 'pct':
                n = a_numero(v)
                # Si viene como 24 en vez de 0.24, se normaliza a fraccion
                d[destino] = (n / 100 if n and n > 1.5 else n)
            elif tipo == 'fecha':
                d[destino] = a_fecha(v)
            else:
                d[destino] = str(v).strip() if v not in (None, '') else None
        # La fila la escribio una persona si tiene datos que el sistema no pone
        d['ORIGEN'] = 'Manual' if (d.get('CIUDAD') and d.get('NOMBRE DEL PROYECTO')
                                   and mapa.get('DIRECCION')) else None
        costo = sum(x for x in (d.get('COSTO PROVEEDORES'), d.get('VIÁTICOS + GASOLINA'),
                                d.get('MO PROENERGY'), d.get('IMPREVISTOS')) if x)
        d['COSTO TOTAL'] = costo or None
        filas.append(d)

    # El sombreado azul que puso el script anterior marca las filas que agrego
    for i, r in enumerate(range(3, ws0.max_row + 1)):
        if i >= len(filas):
            break
        relleno = ws0.cell(row=r, column=mapa['OFERTA No']).fill
        agregada = relleno and relleno.fgColor and str(relleno.fgColor.rgb or '').endswith('EAF3FF')
        filas[i]['ORIGEN'] = 'Sistema' if agregada else 'Manual'

    filas.sort(key=lambda d: (d['FECHA'] or date(1900, 1, 1), str(d['OFERTA No'])))
    escribir(ruta, filas)


def escribir(ruta, filas):
    wb = Workbook()
    ws = wb.active
    ws.title = 'Ofertas 2026'

    borde = Border(bottom=Side(style='thin', color='D0D7E2'))
    ws.append([c[0] for c in COLUMNAS])
    for i, (nombre, tipo, ancho) in enumerate(COLUMNAS, 1):
        cel = ws.cell(row=1, column=i)
        cel.font = Font(bold=True, color='FFFFFF', size=10)
        cel.fill = PatternFill('solid', fgColor=AZUL)
        cel.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width = ancho
    ws.row_dimensions[1].height = 32
    # Se congelan el encabezado y las tres primeras columnas: al desplazarse a la
    # derecha se sigue viendo de que oferta y de que cliente es cada fila.
    ws.freeze_panes = 'D2'

    fmt = {'dinero': '$ #,##0', 'pct': '0.0%', 'entero': '#,##0', 'fecha': 'dd/mm/yyyy', 'texto': None}
    for n, d in enumerate(filas, start=2):
        ws.append([d.get(c[0]) for c in COLUMNAS])
        par = (n % 2 == 0)
        for i, (nombre, tipo, _w) in enumerate(COLUMNAS, 1):
            cel = ws.cell(row=n, column=i)
            cel.border = borde
            cel.font = Font(size=10)
            if fmt[tipo]:
                cel.number_format = fmt[tipo]
            cel.alignment = Alignment(
                horizontal='right' if tipo in ('dinero', 'entero', 'pct') else
                           ('center' if tipo == 'fecha' else 'left'),
                vertical='center')
            if par:
                cel.fill = PatternFill('solid', fgColor=GRIS)
        # Utilidad negativa en rojo: es lo que hay que mirar primero
        u = d.get('UTILIDAD $')
        if u is not None and u < 0:
            for col in ('UTILIDAD $', 'UTILIDAD %'):
                c = ws.cell(row=n, column=[x[0] for x in COLUMNAS].index(col) + 1)
                c.font = Font(size=10, bold=True, color='C00000')

    ultima = ws.max_row
    ws.auto_filter.ref = f'A1:{get_column_letter(len(COLUMNAS))}{ultima}'

    # Totales
    tot = ultima + 1
    ws.cell(row=tot, column=1).value = 'TOTAL'
    for i, (nombre, tipo, _w) in enumerate(COLUMNAS, 1):
        cel = ws.cell(row=tot, column=i)
        cel.font = Font(bold=True, size=10)
        cel.fill = PatternFill('solid', fgColor='D9E2F3')
        if tipo == 'dinero':
            L = get_column_letter(i)
            cel.value = f'=SUM({L}2:{L}{ultima})'
            cel.number_format = '$ #,##0'
            cel.alignment = Alignment(horizontal='right')

    resumen(wb, filas)
    salida = ruta.with_name('Ofertas 2026 - PROENERGY.xlsx')
    wb.save(salida)
    print(f'Guardado: {salida}')
    print(f'  filas: {len(filas)}  |  columnas: {len(COLUMNAS)}')
    manual = sum(1 for d in filas if d.get('ORIGEN') == 'Manual')
    print(f'  de origen manual: {manual}  |  cargadas por el sistema: {len(filas) - manual}')


def resumen(wb, filas):
    """Segunda hoja: cuanto se cotizo por mes y por tipo de actividad."""
    ws = wb.create_sheet('Resumen')
    MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
             'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

    def bloque(titulo, encabezados, datos, fila_inicio):
        ws.cell(row=fila_inicio, column=1).value = titulo
        ws.cell(row=fila_inicio, column=1).font = Font(bold=True, size=12, color=AZUL)
        for j, h in enumerate(encabezados, 1):
            c = ws.cell(row=fila_inicio + 1, column=j)
            c.value = h
            c.font = Font(bold=True, color='FFFFFF', size=10)
            c.fill = PatternFill('solid', fgColor=AZUL)
            c.alignment = Alignment(horizontal='center')
        r = fila_inicio + 2
        for fila in datos:
            for j, v in enumerate(fila, 1):
                c = ws.cell(row=r, column=j)
                c.value = v
                c.font = Font(size=10)
                if j >= 3:
                    c.number_format = '$ #,##0'
                elif j == 2:
                    c.number_format = '#,##0'
            r += 1
        return r + 2

    por_mes = {}
    for d in filas:
        if not d['FECHA']:
            continue
        k = d['FECHA'].month
        m = por_mes.setdefault(k, {'n': 0, 'pv': 0.0, 'costo': 0.0})
        m['n'] += 1
        m['pv'] += d.get('PV (SIN IVA)') or 0
        m['costo'] += d.get('COSTO TOTAL') or 0
    datos_mes = [[MESES[k - 1], v['n'], v['pv'], v['costo'], v['pv'] - v['costo']]
                 for k, v in sorted(por_mes.items())]
    fin = bloque('Cotizado por mes', ['Mes', 'Ofertas', 'PV sin IVA', 'Costo', 'Utilidad'], datos_mes, 1)

    por_act = {}
    for d in filas:
        k = d.get('TIPO DE ACTIVIDAD') or '(sin clasificar)'
        a = por_act.setdefault(k, {'n': 0, 'pv': 0.0, 'costo': 0.0})
        a['n'] += 1
        a['pv'] += d.get('PV (SIN IVA)') or 0
        a['costo'] += d.get('COSTO TOTAL') or 0
    datos_act = [[k, v['n'], v['pv'], v['costo'], v['pv'] - v['costo']]
                 for k, v in sorted(por_act.items(), key=lambda x: -x[1]['pv'])]
    fin = bloque('Cotizado por tipo de actividad', ['Actividad', 'Ofertas', 'PV sin IVA', 'Costo', 'Utilidad'],
                 datos_act, fin)

    por_cli = {}
    for d in filas:
        k = d.get('CLIENTE') or '(sin cliente)'
        a = por_cli.setdefault(k, {'n': 0, 'pv': 0.0, 'costo': 0.0})
        a['n'] += 1
        a['pv'] += d.get('PV (SIN IVA)') or 0
        a['costo'] += d.get('COSTO TOTAL') or 0
    top = sorted(por_cli.items(), key=lambda x: -x[1]['pv'])[:15]
    bloque('Top 15 clientes por valor cotizado', ['Cliente', 'Ofertas', 'PV sin IVA', 'Costo', 'Utilidad'],
           [[k, v['n'], v['pv'], v['costo'], v['pv'] - v['costo']] for k, v in top], fin)

    for col, w in zip('ABCDE', (34, 10, 18, 18, 18)):
        ws.column_dimensions[col].width = w


if __name__ == '__main__':
    main()
