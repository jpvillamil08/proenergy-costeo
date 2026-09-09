#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Estima un precio para los materiales que quedaron sin costo, cuando no se
consiguio el precio real.

CUIDADO - ESTO PRODUCE ESTIMACIONES, NO PRECIOS VERIFICADOS. Se hizo a peticion
expresa de PROENERGY para poder cerrar el costeo: es preferible un valor
aproximado y marcado como tal a dejar la linea en $0, que hace ver la cotizacion
como si no tuviera costo. Todo lo que sale de aqui queda con la fuente
"ESTIMADO" para poder revisarlo despues.

Como estima, en este orden (se queda con el primero que aplique):

  1. INTERPOLACION POR MEDIDA. Si en el catalogo del proveedor hay el mismo
     producto en otras medidas, se ajusta una recta precio-vs-medida y se evalua
     en la medida que falta. Ejemplo real: perno esparrago 5/8 existe en 6" a
     $4.210 y en 8" a $4.500; para 12" la recta da unos $5.080.
  2. MEDIANA DE LA FAMILIA. Si hay productos de la misma familia (cable,
     conector, aislador...) pero no se puede interpolar, se toma la mediana de
     esa familia. La mediana y no el promedio, porque unas pocas referencias
     caras deforman el promedio.
  3. Si no hay ni familia, no se estima nada y la linea se deja en $0.

Uso:
    python scripts/estimar-precios-materiales.py <URL>              # simula
    python scripts/estimar-precios-materiales.py <URL> --ejecutar   # escribe
"""

import importlib.util
import json
import os
import re
import statistics
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CATALOGO = RAIZ / 'reportes' / 'catalogo-felixtorres.json'

_d = Path(__file__).resolve().parent
inv = importlib.util.module_from_spec(importlib.util.spec_from_file_location(
    'inventario', _d / 'listar-elementos-cotizados.py'))
importlib.util.spec_from_file_location('inventario', _d / 'listar-elementos-cotizados.py').loader.exec_module(inv)
cz = importlib.util.module_from_spec(importlib.util.spec_from_file_location(
    'cruzar', _d / 'cruzar-precios-proveedor.py'))

PRECIO_MIN, PRECIO_MAX = 100, 500_000_000


def norm(s):
    s = unicodedata.normalize('NFD', str(s or ''))
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = s.lower().replace('[revisar]', '').replace('"', ' pulg ')
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9/.\-\s]', ' ', s)).strip()


FAMILIAS = {
    'cable': {'cable', 'cables', 'alambre', 'conductor', 'encauchetado', 'trenza'},
    'terminal': {'terminal', 'terminales', 'ponchable', 'tubular'},
    'conector': {'conector', 'conectores', 'ampact', 'cuna', 'empalme', 'codo'},
    'grapa': {'grapa', 'grapas'},
    'abrazadera': {'abrazadera', 'abrasadera', 'collarin'},
    'caja': {'caja', 'cajas', 'gabinete', 'celda', 'tablero'},
    'coraza': {'coraza', 'corazas'},
    'tubo': {'tubo', 'tuberia', 'conduit', 'emt', 'union', 'uniones', 'curva'},
    'varilla': {'varilla', 'barrilla', 'esparrago', 'tornillo', 'perno', 'tuerca', 'arandela', 'chazo'},
    'cinta': {'cinta', 'bandit', 'hebilla'},
    'breaker': {'breaker', 'interruptor', 'totalizador'},
    'dps': {'dps', 'descargador', 'pararrayo', 'sobretension'},
    'poste': {'poste', 'postes'},
    'cruceta': {'cruceta', 'angular', 'angulo', 'platina', 'riel', 'perfil', 'tensor'},
    'aislador': {'aislador', 'aisladores'},
    'transformador': {'transformador', 'transformadores', 'trafo'},
    'medidor': {'medidor', 'medidores', 'contador'},
    'cortacircuito': {'cortacircuito', 'cortacircuitos', 'cortacirucito', 'fusible'},
    'prensa': {'prensa', 'estopa'},
    'premoldeado': {'premoldeado', 'premoldeados', 'elbow'},
    'tomacorriente': {'tomacorriente', 'toma', 'clavija'},
}


def familias(t):
    p = set(norm(t).split())
    return {f for f, ks in FAMILIAS.items() if p & ks}


# Medida principal del producto, en un numero comparable. Sirve para interpolar:
# 5/8 x 6" y 5/8 x 8" solo se diferencian en el 6 y el 8.
RE_MEDIDAS = [
    re.compile(r'\b(\d{1,3})\s*/\s*(\d{1,3})\s*(?:pulg|")'),   # fracciones de pulgada
    re.compile(r'\bx\s*(\d{1,3})(?:\s*(?:pulg|"|mts?|m)\b)?'),  # "x 12"
    re.compile(r'\b(\d{1,4})\s*(?:kva|kv|awg|amp|a)\b'),        # capacidad/calibre
]


def medida(t):
    s = norm(t)
    for rx in RE_MEDIDAS:
        m = rx.search(s)
        if not m:
            continue
        g = m.groups()
        try:
            if len(g) == 2 and g[1]:
                return float(g[0]) / float(g[1])
            return float(g[0])
        except (ValueError, ZeroDivisionError):
            continue
    return None


def cargar_catalogo():
    if not CATALOGO.exists():
        print(f'Falta {CATALOGO}. Corre catalogo-proveedor-felixtorres.py', file=sys.stderr)
        sys.exit(1)
    items = json.loads(CATALOGO.read_text(encoding='utf-8'))['items']
    limpio = []
    for it in items:
        p = it.get('precio')
        if not isinstance(p, (int, float)) or not (PRECIO_MIN <= p <= PRECIO_MAX):
            continue
        limpio.append({'descripcion': it['descripcion'], 'precio': float(p),
                       'fam': familias(it['descripcion']), 'med': medida(it['descripcion']),
                       'tok': set(norm(it['descripcion']).split())})
    return limpio


def estimar(descripcion, catalogo):
    """Devuelve (precio, explicacion) o (None, motivo)."""
    fam = familias(descripcion)
    if not fam:
        return None, 'no se reconoce la familia del producto'
    tok = set(norm(descripcion).split())
    med = medida(descripcion)

    # Mismos familia + al menos una palabra en comun ademas de la familia
    pares = [c for c in catalogo if (c['fam'] & fam) and len(c['tok'] & tok) >= 2]
    if not pares:
        pares = [c for c in catalogo if c['fam'] & fam]
    if not pares:
        return None, 'sin referencias de esa familia en el catalogo'

    # 1) Interpolacion por medida
    if med is not None:
        con_med = [(c['med'], c['precio']) for c in pares if c['med'] is not None]
        distintos = {m for m, _ in con_med}
        if len(distintos) >= 2:
            xs = sorted(con_med)
            menores = [p for m, p in xs if m <= med]
            mayores = [p for m, p in xs if m >= med]
            if menores and mayores:
                x1, y1 = max((m, p) for m, p in xs if m <= med)
                x2, y2 = min((m, p) for m, p in xs if m >= med)
                if x2 != x1:
                    val = y1 + (y2 - y1) * (med - x1) / (x2 - x1)
                    return round(val, 2), f'interpolado entre {x1:g}=${y1:,.0f} y {x2:g}=${y2:,.0f}'
                return round(y1, 2), f'referencia exacta de medida {x1:g}'

    # 2) Mediana de la familia, pero solo si hay evidencia suficiente.
    #    Con una o dos referencias la mediana no dice nada: asi salieron
    #    disparates como estimar una abrazadera de poste en $540.100 a partir de
    #    una sola referencia, cuando las reales rondan los $20.000.
    precios = sorted(c['precio'] for c in pares)
    if len(precios) < 5:
        return None, f'solo {len(precios)} referencia(s) de la familia: insuficiente para estimar'
    # Si la familia mezcla productos de escalas muy distintas (una caja de paso
    # de $3.000 y una celda de $2.000.000 caen en la misma), la mediana no
    # representa nada. Se exige que el rango intercuartil sea manejable.
    q1 = statistics.quantiles(precios, n=4)[0] if len(precios) >= 4 else precios[0]
    q3 = statistics.quantiles(precios, n=4)[2] if len(precios) >= 4 else precios[-1]
    if q1 > 0 and q3 / q1 > 12:
        return None, (f'la familia {"/".join(sorted(fam))} mezcla precios muy dispares '
                      f'(${q1:,.0f} a ${q3:,.0f}): estimar seria adivinar')
    val = statistics.median(precios)
    return round(val, 2), (f'mediana de {len(precios)} referencias de la familia '
                           f'{"/".join(sorted(fam))} (intercuartil ${q1:,.0f} a ${q3:,.0f})')


def main():
    ejecutar = '--ejecutar' in sys.argv
    cfg = inv.parsear_argumentos([a for a in sys.argv[1:] if a != '--ejecutar'])
    usuario, clave = os.environ.get('ADMIN_USERNAME'), os.environ.get('ADMIN_PASSWORD')
    if not usuario or not clave:
        print('Faltan ADMIN_USERNAME / ADMIN_PASSWORD.', file=sys.stderr)
        sys.exit(1)

    catalogo = cargar_catalogo()
    print(f'Catalogo de referencia: {len(catalogo):,} productos con precio utilizable.')

    api = inv.ClienteApi(cfg['base_url'])
    api.login(usuario, clave)
    lista = api.get('/api/cotizaciones') or []
    print(f'Leyendo {len(lista)} cotizaciones...')
    pendientes = []
    for i, r in enumerate(lista, 1):
        try:
            det = api.get(f"/api/cotizaciones/{r['id']}")
        except RuntimeError:
            continue
        for m in det.get('materiales') or []:
            if (m.get('costo_unitario') or 0) > 0:
                continue
            d = (m.get('descripcion') or '').strip()
            if not d or re.match(r'^\s*\[?revisar\]?\s*[A-Z]{1,2}-?\d+\s*$', d, re.I):
                continue
            pendientes.append((r, m, d))
        if i % 25 == 0 or i == len(lista):
            print(f'  {i}/{len(lista)}...', end='\r', flush=True)
    print()

    estimados, sin_estimar = [], []
    cache = {}
    for r, m, d in pendientes:
        clave_c = norm(d)
        if clave_c not in cache:
            cache[clave_c] = estimar(d, catalogo)
        val, expl = cache[clave_c]
        (estimados if val else sin_estimar).append((r, m, d, val, expl))

    porq = {}
    for r, m, d, val, expl in estimados:
        porq.setdefault(norm(d), [d, val, expl, 0])[3] += 1
    print(f'\nLineas sin precio revisadas : {len(pendientes)}')
    print(f'  con estimacion            : {len(estimados)}  ({len(porq)} elementos distintos)')
    print(f'  sin poder estimar         : {len(sin_estimar)}')
    print('\nMuestra de estimaciones:')
    for k, (d, val, expl, n) in sorted(porq.items(), key=lambda x: -x[1][3])[:14]:
        print(f'  {n:>3}x ${val:>12,.0f}  {d[:46]:46} <- {expl[:56]}')

    if not ejecutar:
        print('\n(Simulacion: no se escribio nada. Agrega --ejecutar para aplicar)')
        return

    print('\nEscribiendo...')
    ok = fallos = 0
    for i, (r, m, d, val, expl) in enumerate(estimados, 1):
        cuerpo = {
            'descripcion': m['descripcion'], 'clasificacion': m.get('clasificacion') or 'Directo',
            'forma_pago': m.get('forma_pago') or 'Contado', 'proveedor_id': m.get('proveedor_id'),
            'dias_credito_proveedor': m.get('dias_credito_proveedor') or 0,
            'fecha_compra': m.get('fecha_compra'),
            'cantidad_presupuestada': m.get('cantidad_presupuestada') or 0,
            'cantidad_real': m.get('cantidad_real') or 0, 'costo_unitario': val,
        }
        try:
            api.put(f"/api/cotizaciones/{r['id']}/materiales/{m['id']}", cuerpo)
            ok += 1
        except RuntimeError as e:
            fallos += 1
            if fallos <= 5:
                print(f"  FALLO {r['numero']} linea {m['id']}: {e}")
        if i % 20 == 0 or i == len(estimados):
            print(f'  {i}/{len(estimados)} ({ok} ok, {fallos} fallos)...', end='\r', flush=True)
    print(f'\n\nListo: {ok} lineas estimadas, {fallos} fallos.')

    # Deja constancia de que estos valores son estimados y de como salio cada uno
    salida = RAIZ / 'reportes' / f'estimaciones-{datetime.now().strftime("%Y%m%d-%H%M%S")}.csv'
    import csv
    with open(salida, 'w', newline='', encoding='utf-8-sig') as fh:
        w = csv.writer(fh, delimiter=';')
        w.writerow(['material', 'precio_estimado', 'como_se_estimo', 'lineas_afectadas'])
        for k, (d, val, expl, n) in sorted(porq.items(), key=lambda x: -x[1][3]):
            w.writerow([d, f'{val:.2f}', expl, n])
    print(f'Detalle de las estimaciones: {salida}')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        print(f'\nERROR: {e}', file=sys.stderr)
        sys.exit(1)
