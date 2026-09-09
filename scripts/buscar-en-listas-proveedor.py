#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Buscador manual dentro de las listas de precios descargadas del proveedor.

Para que existe: el cruce automatico (cruzar-precios-proveedor.py) resulto poco
confiable porque cada uno de los 121 archivos tiene su propia plantilla y la
columna de precio no siempre es la misma. Este script no adivina: muestra la
FILA COMPLETA tal como esta en el archivo original, con todas sus columnas y su
encabezado, para que una persona vea cual columna es el precio y lo lea con sus
propios ojos.

Uso:
    python scripts/buscar-en-listas-proveedor.py "coraza lt"
    python scripts/buscar-en-listas-proveedor.py "cortacircuito" --archivo=CELSA
    python scripts/buscar-en-listas-proveedor.py "terminal ojo" --max=15
"""

import re
import sys
import unicodedata
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CACHE = RAIZ / '.cache-felixtorres'


def normalizar(s):
    s = unicodedata.normalize('NFD', str(s or ''))
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = s.lower().replace('"', ' ').replace('°', ' ').replace('º', ' ')
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9/.\-\s]', ' ', s)).strip()


def coincide(texto, terminos):
    n = normalizar(texto)
    return all(t in n for t in terminos)


def celda(v, ancho=22):
    s = re.sub(r'\s+', ' ', str(v)).strip() if v is not None else ''
    return s[:ancho]


def filas_xlsx(ruta):
    from openpyxl import load_workbook
    wb = load_workbook(ruta, read_only=True, data_only=True)
    try:
        for hoja in wb.sheetnames:
            for n, fila in enumerate(wb[hoja].iter_rows(max_col=12, values_only=True), 1):
                yield hoja, n, list(fila)
    finally:
        wb.close()


def filas_xls(ruta):
    import xlrd
    wb = xlrd.open_workbook(ruta)
    for sh in wb.sheets():
        for r in range(sh.nrows):
            yield sh.name, r + 1, [sh.cell_value(r, c) for c in range(min(sh.ncols, 12))]


def filas_pdf(ruta):
    import pdfplumber
    with pdfplumber.open(ruta) as pdf:
        for np_, pagina in enumerate(pdf.pages[:80], 1):
            try:
                tablas = pagina.extract_tables()
            except Exception:
                tablas = []
            if tablas:
                for t in tablas:
                    for n, fila in enumerate(t, 1):
                        yield f'p{np_}', n, list(fila)
            else:
                for n, linea in enumerate((pagina.extract_text() or '').split('\n'), 1):
                    if linea.strip():
                        yield f'p{np_}', n, re.split(r'\s{2,}|\t', linea)


def filas(ruta):
    ext = ruta.suffix.lower()
    if ext == '.xlsx':
        return filas_xlsx(ruta)
    if ext == '.xls':
        return filas_xls(ruta)
    if ext == '.pdf':
        return filas_pdf(ruta)
    return iter(())


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = dict(re.match(r'^--([a-z]+)=(.*)$', a).groups()
                for a in sys.argv[1:] if re.match(r'^--([a-z]+)=(.*)$', a))
    if not args:
        print('Uso: python scripts/buscar-en-listas-proveedor.py "<texto>" '
              '[--archivo=FRAGMENTO] [--max=N]', file=sys.stderr)
        sys.exit(1)

    terminos = normalizar(args[0]).split()
    filtro_archivo = normalizar(opts.get('archivo', ''))
    tope = int(opts.get('max', 30))

    archivos = sorted(CACHE.glob('*'))
    if filtro_archivo:
        archivos = [a for a in archivos if filtro_archivo in normalizar(a.name)]
    if not archivos:
        print(f'No hay archivos en {CACHE}. Corre primero catalogo-proveedor-felixtorres.py',
              file=sys.stderr)
        sys.exit(1)

    print(f'Buscando {terminos} en {len(archivos)} archivo(s)...\n')
    encontrados = 0
    for ruta in archivos:
        try:
            hits = []
            encabezado = None
            for hoja, n, fila in filas(ruta):
                texto = ' '.join(str(c) for c in fila if c is not None)
                # Guarda como posible encabezado la ultima fila con palabras clave
                if re.search(r'(?i)\b(precio|valor|descripcion|referencia|codigo)\b', texto):
                    encabezado = (hoja, n, fila)
                if coincide(texto, terminos):
                    hits.append((hoja, n, fila, encabezado))
                    if len(hits) >= tope:
                        break
            if not hits:
                continue
            print(f'\n{"="*100}\nARCHIVO: {ruta.name}')
            enc_mostrado = None
            for hoja, n, fila, enc in hits:
                if enc and enc != enc_mostrado:
                    print(f'  encabezado [{enc[0]} fila {enc[1]}]: ' +
                          ' | '.join(celda(c, 18) for c in enc[2] if c is not None and str(c).strip()))
                    enc_mostrado = enc
                print(f'  [{hoja} f{n}] ' + ' | '.join(celda(c, 24) for c in fila
                                                       if c is not None and str(c).strip() != ''))
                encontrados += 1
        except Exception as e:
            print(f'  ({ruta.name}: no se pudo leer - {type(e).__name__})', file=sys.stderr)

    print(f'\n{"="*100}\nCoincidencias mostradas: {encontrados}')
    if not encontrados:
        print('Ninguna. Prueba con menos palabras o un sinonimo.')


if __name__ == '__main__':
    main()
