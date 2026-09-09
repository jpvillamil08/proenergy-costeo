#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Carga en la aplicacion los precios que ya fueron verificados a mano contra las
listas del proveedor (reportes/precios-verificados-felixtorres.csv).

ESCRIBE EN PRODUCCION. Por eso:
  - Por defecto SIMULA: muestra exactamente que lineas cambiarian y en cuanto,
    sin tocar nada. Hay que pasar --ejecutar para que escriba de verdad.
  - Solo toca lineas cuyo costo_unitario sea 0 o nulo. Si alguien ya le puso un
    precio a mano a una linea, no se pisa.
  - Solo cambia el costo_unitario: descripcion, cantidades, proveedor y forma de
    pago se reenvian tal como estan (el PUT de la API reemplaza la fila completa,
    asi que hay que mandar los valores actuales para no borrarlos).
  - Cada cambio queda en la auditoria de la app (registrarCambios), con el valor
    anterior y el nuevo.

El emparejamiento es por descripcion normalizada EXACTA contra la lista de
variantes declarada abajo. No hay busqueda difusa aqui a proposito: el cruce
automatico ya demostro equivocarse (ver cruzar-precios-proveedor.py), asi que
estos precios se aplican solo donde la descripcion coincide sin ambiguedad.

Uso:
    $env:ADMIN_USERNAME = "admin"
    $env:ADMIN_PASSWORD = "tu-clave"
    python scripts/aplicar-precios-verificados.py <URL>              # simula
    python scripts/aplicar-precios-verificados.py <URL> --ejecutar   # escribe
"""

import importlib.util
import os
import sys
import unicodedata
import re
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location(
    'inventario', Path(__file__).resolve().parent / 'listar-elementos-cotizados.py')
inventario = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inventario)


def norm(s):
    s = unicodedata.normalize('NFD', str(s or ''))
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = s.lower().replace('[revisar]', '')
    return re.sub(r'\s+', ' ', s).strip()


# Precios verificados uno por uno contra las listas del proveedor.
# 'variantes' son todas las formas en que esa misma cosa aparece escrita en las
# cotizaciones; se comparan normalizadas (sin tildes, minusculas, sin [REVISAR]).
PRECIOS = [
    {
        'nombre': 'CORAZA LT 1"',
        'precio': 10784,
        'fuente': 'Metal Coraza - Lista LT Industrial, 1" = $10.784/metro',
        'variantes': ['CORAZA LT 1'],
    },
    {
        'nombre': 'DPS POLIMERICO DE 15KV',
        'precio': 213109,
        'fuente': 'CELSA 52850 PARARRAYO POLIMERICO 15KV 10KA (presupuesto)',
        'variantes': ['DPS POLIMERICO DE 15KV'],
    },
    {
        'nombre': 'CABLE CU N°2 DESNUDO',
        'precio': 23815,
        'fuente': 'CENTELSA 213790CK C.DESNUDO 2 AWG COBRE 7 HILOS (presupuesto)',
        'variantes': ['CABLE CU N°2 DESNUDO'],
    },
    {
        'nombre': 'PLATINA GALVANIZADA Y/O RIEL CHANEL',
        'precio': 21910,
        'fuente': 'SOLUCIONES MDS 2112E01135 RIEL CHANEL 3MTS 4X2 (presupuesto)',
        'variantes': ['PLATINA GALVANIZADA Y/O RIEL CHANEL'],
    },
    {
        'nombre': 'HEBILLA CINTA BANDIT 3/4',
        'precio': 535.84,
        'fuente': 'IMPUCHE HAI001238 HEBILLA CINTA BANDIT 3/4" INOX 304 (presupuesto)',
        'variantes': ['HEBILLA CINTA BANDIT 3/4', 'HEBILLA PARA CINTA BANDIT 3/4'],
    },
    {
        'nombre': 'CONECTOR AMPACT #2 a #2',
        'precio': 4901.60,
        'fuente': '4S CADC-103 CON.AMPACT 2AWG-2AWG (presupuesto)',
        'variantes': ['CONECTOR AMPACT #2 a #2', 'Conector Ampac #2 a #2'],
    },
    {
        'nombre': 'CABLE CU N°12 VERDE',
        'precio': 2655.27,
        'fuente': 'CENTELSA 200354CKVR C.THHN-THWN-2 12 VERDE (presupuesto)',
        'variantes': ['CABLE CU N°12 VERDE - Centelsa'],
    },
    {
        'nombre': 'CABLE CU N°12 BLANCO',
        'precio': 2655.27,
        'fuente': 'CENTELSA 200354CKBL C.THHN-THWN-2 12 BLANCO (presupuesto)',
        'variantes': ['CABLE CU N°12 BLANCO centelsa'],
    },
]


def main():
    ejecutar = '--ejecutar' in sys.argv
    cfg = inventario.parsear_argumentos([a for a in sys.argv[1:] if a != '--ejecutar'])
    usuario, clave = os.environ.get('ADMIN_USERNAME'), os.environ.get('ADMIN_PASSWORD')
    if not usuario or not clave:
        print('Faltan ADMIN_USERNAME / ADMIN_PASSWORD.', file=sys.stderr)
        sys.exit(1)

    objetivo = {}
    for p in PRECIOS:
        for v in p['variantes']:
            objetivo[norm(v)] = p

    api = inventario.ClienteApi(cfg['base_url'])
    print(f"Conectando a {cfg['base_url']} ...")
    api.login(usuario, clave)
    print('Sesion iniciada.\n')

    lista = api.get('/api/cotizaciones') or []
    print(f'Revisando {len(lista)} cotizaciones...')
    pendientes = []   # (cotizacion, linea, precio_nuevo, ficha)
    ya_tenian = []
    for i, res in enumerate(lista, 1):
        try:
            det = api.get(f"/api/cotizaciones/{res['id']}")
        except RuntimeError as e:
            print(f"  aviso: no se pudo leer {res.get('numero')}: {e}")
            continue
        for m in det.get('materiales') or []:
            ficha = objetivo.get(norm(m.get('descripcion')))
            if not ficha:
                continue
            actual = m.get('costo_unitario') or 0
            if actual and float(actual) > 0:
                ya_tenian.append((res['numero'], m['descripcion'], float(actual)))
                continue
            pendientes.append((res, m, ficha))
        if i % 25 == 0 or i == len(lista):
            print(f'  {i}/{len(lista)}...', end='\r', flush=True)
    print()

    por_material = {}
    total_costo = 0.0
    for res, m, ficha in pendientes:
        d = por_material.setdefault(ficha['nombre'], {'lineas': 0, 'cantidad': 0.0,
                                                      'precio': ficha['precio'], 'fuente': ficha['fuente']})
        d['lineas'] += 1
        cant = float(m.get('cantidad_presupuestada') or 0)
        d['cantidad'] += cant
        total_costo += cant * ficha['precio']

    print('\n' + '=' * 92)
    print('SIMULACION' if not ejecutar else 'APLICANDO CAMBIOS')
    print('=' * 92)
    for nombre, d in sorted(por_material.items(), key=lambda x: -x[1]['lineas']):
        print(f"  {nombre[:40]:40} {d['lineas']:4} lineas  x  ${d['precio']:>12,.2f}"
              f"  =  ${d['cantidad'] * d['precio']:>15,.0f}")
        print(f"      {d['fuente'][:84]}")
    print('-' * 92)
    print(f"  TOTAL: {len(pendientes)} lineas en {len({r['id'] for r, _, _ in pendientes})} cotizaciones")
    print(f"  Costo que se agrega al costeo de la empresa: ${total_costo:,.0f}")
    if ya_tenian:
        print(f"\n  {len(ya_tenian)} linea(s) ya tenian precio y NO se tocan:")
        for n, d, v in ya_tenian[:5]:
            print(f'      {n} | {d[:44]:44} | ${v:,.0f}')

    if not ejecutar:
        print('\n(Simulacion: no se escribio nada. Para aplicar de verdad, agrega --ejecutar)')
        return

    print('\nEscribiendo...')
    ok = fallos = 0
    for i, (res, m, ficha) in enumerate(pendientes, 1):
        cuerpo = {
            'descripcion': m['descripcion'],
            'clasificacion': m.get('clasificacion') or 'Directo',
            'forma_pago': m.get('forma_pago') or 'Contado',
            'proveedor_id': m.get('proveedor_id'),
            'dias_credito_proveedor': m.get('dias_credito_proveedor') or 0,
            'fecha_compra': m.get('fecha_compra'),
            'cantidad_presupuestada': m.get('cantidad_presupuestada') or 0,
            'cantidad_real': m.get('cantidad_real') or 0,
            'costo_unitario': ficha['precio'],
        }
        try:
            api.put(f"/api/cotizaciones/{res['id']}/materiales/{m['id']}", cuerpo)
            ok += 1
        except RuntimeError as e:
            fallos += 1
            print(f"  FALLO {res['numero']} linea {m['id']}: {e}")
        if i % 10 == 0 or i == len(pendientes):
            print(f'  {i}/{len(pendientes)} ({ok} ok, {fallos} fallos)...', end='\r', flush=True)
    print(f'\n\nListo: {ok} lineas actualizadas, {fallos} fallos.')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        print(f'\nERROR: {e}', file=sys.stderr)
        sys.exit(1)
