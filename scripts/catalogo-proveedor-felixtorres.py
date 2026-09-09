#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Descarga y parsea las listas de precios publicadas por FELIX TORRES Y CIA
(https://felixtorresycia.com/listas-de-precios-y-catalogos/) y construye un
catalogo unificado de referencias con precio, para poder cruzarlo despues
contra los materiales de las cotizaciones que estan sin precio.

Formatos que maneja (los tres que publica el sitio):
  .xlsx  -> openpyxl
  .xls   -> xlrd 1.2 (formato OLE2 viejo, openpyxl NO lo lee)
  .pdf   -> pdfplumber (tablas; si no hay tabla, texto por lineas)

Se saltan los catalogos y manuales tecnicos (los que siguen el patron
MARCA-00N-nombre.pdf): son brochures de producto sin precios, y pesan mucho.

NO INVENTA NADA: solo extrae filas donde encuentra a la vez una descripcion y
un numero que parece precio. Lo que no puede interpretar se descarta y se
reporta en el conteo, nunca se rellena.

Uso:
    python scripts/catalogo-proveedor-felixtorres.py [--solo-descargar] [--limite=N]

Deja dos cosas:
    reportes/catalogo-felixtorres.json   catalogo unificado
    <cache>/felixtorres/                 archivos descargados (se reutilizan)
"""

import json
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CACHE = RAIZ / '.cache-felixtorres'
SALIDA = RAIZ / 'reportes' / 'catalogo-felixtorres.json'
LISTA_URLS = Path(__file__).resolve().parent / 'felixtorres-archivos.txt'

# Catalogos/manuales tecnicos: MARCA-001-loquesea.pdf. No traen precios.
PATRON_CATALOGO_TECNICO = re.compile(
    r'/(SE|CENTELSA|LAUM|TYCO|WEG|GONVARRI|CELSA|DURMAN|GROUNDING|4S|CELTA|CILES|ROBLAN|OBO|VISBAL|TECNOWELD|INADISA|C\.I\.-COBRES-COL)-\d{3}',
    re.IGNORECASE,
)
PATRON_PRECIOS = re.compile(r'precio|presupuesto|promo|lista', re.IGNORECASE)


def parece_lista_de_precios(url):
    if PATRON_CATALOGO_TECNICO.search(url):
        return False
    return bool(PATRON_PRECIOS.search(url.rsplit('/', 1)[-1]))


def marca_desde_url(url):
    """Nombre de la marca/proveedor, inferido del nombre del archivo."""
    n = url.rsplit('/', 1)[-1]
    n = re.sub(r'\.(xlsx?|pdf)$', '', n, flags=re.IGNORECASE)
    n = re.sub(r'(?i)^(copia-de-|lista-de-|lista-|l\.?)?(precios?|presupuesto|promo(cion)?|listado)[-_ ]*', '', n)
    n = re.sub(r'(?i)[-_ ]*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|sept|octubre|noviembre|diciembre)[-_ ]*', ' ', n)
    n = re.sub(r'[-_]+', ' ', n)
    n = re.sub(r'\b(19|20)\d{2}\b', '', n)
    n = re.sub(r'\s+', ' ', n).strip(' -_.')
    return (n or 'FELIX TORRES')[:40].upper()


# ------------------------------------------------------------------ descarga

def nombre_local(url):
    return re.sub(r'[^A-Za-z0-9._-]', '_', url.rsplit('/', 1)[-1])


def descargar(url):
    destino = CACHE / nombre_local(url)
    if destino.exists() and destino.stat().st_size > 0:
        return destino, 'cache'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (compatible; PROENERGY-costeo/1.0)',
        'Accept': '*/*',
    })
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            datos = r.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError) as e:
        return None, f'error: {getattr(e, "reason", e)}'
    if not datos:
        return None, 'vacio'
    destino.write_bytes(datos)
    return destino, f'{len(datos)//1024} KB'


# ------------------------------------------------------------------ utilidades

# Un precio en estas listas puede venir como 1234.56, "1.234,56", "$ 1.234" o
# como numero de Excel. Se descartan los valores absurdos (0, negativos o
# gigantes) porque suelen ser codigos, anios o celdas de encabezado.
PRECIO_MIN = 50
PRECIO_MAX = 5_000_000_000


def a_precio(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        n = float(v)
    else:
        s = str(v).strip().replace('$', '').replace(' ', '').replace('\xa0', '')
        if not s or not re.search(r'\d', s):
            return None
        # "1.234,56" (es-CO) vs "1,234.56" (en-US)
        if ',' in s and '.' in s:
            s = s.replace('.', '').replace(',', '.') if s.rfind(',') > s.rfind('.') else s.replace(',', '')
        elif ',' in s:
            partes = s.split(',')
            s = s.replace(',', '.') if len(partes[-1]) <= 2 else s.replace(',', '')
        elif s.count('.') > 1:
            s = s.replace('.', '')
        try:
            n = float(s)
        except ValueError:
            return None
    if n != n or n < PRECIO_MIN or n > PRECIO_MAX:
        return None
    return round(n, 2)


def es_descripcion(v):
    if v is None:
        return False
    s = str(v).strip()
    return len(s) >= 4 and bool(re.search(r'[A-Za-zÁÉÍÓÚÑáéíóúñ]{3}', s))


def limpiar(s):
    s = str(s or '').replace('\x00', ' ')
    # Los .xls viejos vienen en cp1252 mal decodificado: se normaliza lo que se pueda
    s = unicodedata.normalize('NFKC', s)
    return re.sub(r'\s+', ' ', s).strip()


def filas_a_items(filas, origen, marca):
    """De una tabla generica saca (referencia, descripcion, precio).

    No asume posicion de columnas: en cada fila toma la celda de texto mas larga
    como descripcion, el precio mas a la derecha como precio, y un codigo corto
    alfanumerico como referencia. Es lo que permite leer decenas de plantillas
    distintas sin escribir un parser por archivo.
    """
    items = []
    for fila in filas:
        celdas = [c for c in fila if c is not None and str(c).strip() != '']
        if len(celdas) < 2:
            continue
        precios = [(i, a_precio(c)) for i, c in enumerate(fila)]
        precios = [(i, p) for i, p in precios if p is not None]
        if not precios:
            continue
        idx_precio, precio = precios[-1]
        textos = [(i, limpiar(c)) for i, c in enumerate(fila)
                  if i != idx_precio and es_descripcion(c)]
        if not textos:
            continue
        idx_desc, descripcion = max(textos, key=lambda t: len(t[1]))
        if len(descripcion) < 4:
            continue
        referencia = ''
        for i, t in textos:
            if i != idx_desc and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9./\-]{2,24}', t):
                referencia = t
                break
        items.append({
            'referencia': referencia,
            'descripcion': descripcion[:200],
            'precio': precio,
            'origen': origen,
            'marca': marca,
        })
    return items


# ------------------------------------------------------------------ parsers

def parsear_xlsx(ruta, marca):
    from openpyxl import load_workbook
    items = []
    wb = load_workbook(ruta, read_only=True, data_only=True)
    try:
        for hoja in wb.sheetnames:
            ws = wb[hoja]
            filas = []
            for fila in ws.iter_rows(max_col=15, values_only=True):
                filas.append(list(fila))
                if len(filas) > 20000:
                    break
            items += filas_a_items(filas, f'{ruta.name} [{hoja}]', marca)
    finally:
        wb.close()
    return items


def parsear_xls(ruta, marca):
    import xlrd
    items = []
    wb = xlrd.open_workbook(ruta)
    for sh in wb.sheets():
        filas = [[sh.cell_value(r, c) for c in range(min(sh.ncols, 15))]
                 for r in range(min(sh.nrows, 20000))]
        items += filas_a_items(filas, f'{ruta.name} [{sh.name}]', marca)
    return items


def parsear_pdf(ruta, marca, max_paginas=60):
    import pdfplumber
    items = []
    with pdfplumber.open(ruta) as pdf:
        for n, pagina in enumerate(pdf.pages[:max_paginas], 1):
            try:
                tablas = pagina.extract_tables()
            except Exception:
                tablas = []
            if tablas:
                for t in tablas:
                    items += filas_a_items(t, f'{ruta.name} [p{n}]', marca)
            else:
                # Sin tabla detectable: se parte cada linea por 2+ espacios
                texto = pagina.extract_text() or ''
                filas = [re.split(r'\s{2,}|\t', l) for l in texto.split('\n') if l.strip()]
                items += filas_a_items([f for f in filas if len(f) >= 2], f'{ruta.name} [p{n}]', marca)
    return items


def parsear(ruta, marca):
    ext = ruta.suffix.lower()
    if ext == '.xlsx':
        return parsear_xlsx(ruta, marca)
    if ext == '.xls':
        return parsear_xls(ruta, marca)
    if ext == '.pdf':
        return parsear_pdf(ruta, marca)
    return []


# ------------------------------------------------------------------ principal

def main():
    solo_descargar = '--solo-descargar' in sys.argv
    limite = None
    for a in sys.argv[1:]:
        m = re.match(r'^--limite=(\d+)$', a)
        if m:
            limite = int(m.group(1))

    if not LISTA_URLS.exists():
        print(f'Falta la lista de archivos: {LISTA_URLS}', file=sys.stderr)
        sys.exit(1)

    urls = []
    for linea in LISTA_URLS.read_text(encoding='utf-8').splitlines():
        if '\t' in linea:
            _, url = linea.split('\t', 1)
        else:
            url = linea
        url = url.strip()
        if url.startswith('http'):
            urls.append(url)
    urls = list(dict.fromkeys(urls))

    con_precios = [u for u in urls if parece_lista_de_precios(u)]
    saltados = [u for u in urls if u not in con_precios]
    if limite:
        con_precios = con_precios[:limite]

    CACHE.mkdir(exist_ok=True)
    print(f'Archivos publicados en el sitio : {len(urls)}')
    print(f'Con pinta de lista de precios   : {len(con_precios)}')
    print(f'Saltados (catalogos tecnicos)   : {len(saltados)}')
    print('\nDescargando...')

    descargados = []
    fallidos = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        for i, (url, (ruta, estado)) in enumerate(zip(con_precios, ex.map(descargar, con_precios)), 1):
            if ruta is None:
                fallidos.append({'url': url, 'estado': estado})
            else:
                descargados.append((url, ruta))
            if i % 10 == 0 or i == len(con_precios):
                print(f'  {i}/{len(con_precios)}...', end='\r', flush=True)
    print(f'\nDescargados: {len(descargados)} | fallidos: {len(fallidos)}')
    if solo_descargar:
        return

    print('\nParseando...')
    catalogo = []
    por_archivo = []
    errores = []
    for i, (url, ruta) in enumerate(descargados, 1):
        marca = marca_desde_url(url)
        try:
            items = parsear(ruta, marca)
        except Exception as e:
            errores.append({'archivo': ruta.name, 'error': f'{type(e).__name__}: {e}'})
            items = []
        catalogo += items
        por_archivo.append({'archivo': ruta.name, 'marca': marca, 'items': len(items), 'url': url})
        print(f'  {i}/{len(descargados)}  {ruta.name[:52]:52} {len(items):6} items', end='\r', flush=True)
    print()

    SALIDA.parent.mkdir(exist_ok=True)
    SALIDA.write_text(json.dumps({
        'fuente': 'https://felixtorresycia.com/listas-de-precios-y-catalogos/',
        'archivos_procesados': len(descargados),
        'archivos_saltados': len(saltados),
        'total_items': len(catalogo),
        'por_archivo': sorted(por_archivo, key=lambda x: -x['items']),
        'errores': errores,
        'fallidos': fallidos,
        'items': catalogo,
    }, ensure_ascii=False), encoding='utf-8')

    print(f'\nCatalogo guardado en: {SALIDA}')
    print(f'Referencias con precio extraidas: {len(catalogo):,}')
    print(f'Archivos que no dieron ningun item: {sum(1 for a in por_archivo if a["items"] == 0)}')
    if errores:
        print(f'Errores de parseo: {len(errores)}')
        for e in errores[:8]:
            print(f'   - {e["archivo"]}: {e["error"][:90]}')
    print('\nTop archivos por cantidad de referencias:')
    for a in sorted(por_archivo, key=lambda x: -x['items'])[:12]:
        print(f'   {a["items"]:6}  {a["marca"][:28]:28}  {a["archivo"][:46]}')


if __name__ == '__main__':
    main()
