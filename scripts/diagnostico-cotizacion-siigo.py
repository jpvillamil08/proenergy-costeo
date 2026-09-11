#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Diagnostico, solo lectura: muestra una cotizacion tal como la devuelve Siigo,
para ubicar en que campo guarda el titulo (en Observaciones no esta: C-1-235,
C-1-236 y C-1-237 salieron sin titulo aunque en Siigo si lo tienen).

Imprime cada campo de texto no vacio con su ruta, primero los que estan fuera
de los items (ahi deberia estar el titulo), y dice si el filtro updated_start
de Siigo funciona (lo necesita la sincronizacion de cotizaciones modificadas).
Deja el JSON completo en reportes/diagnostico-siigo-<numero>.json.

Credenciales: las del Administrador de credenciales de Windows (entrada
"proenergy-costeo") o ADMIN_USERNAME / ADMIN_PASSWORD. Nunca en este archivo.

Uso:
    python scripts/diagnostico-cotizacion-siigo.py <URL> C-1-235 C-1-237
"""

import importlib.util
import json
import sys
import urllib.parse
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


def cargar(nombre, archivo):
    spec = importlib.util.spec_from_file_location(nombre, RAIZ / 'scripts' / archivo)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def hojas(valor, ruta=''):
    """(ruta, texto) de cada valor de texto o numero no vacio."""
    if isinstance(valor, dict):
        for k, v in valor.items():
            yield from hojas(v, '%s.%s' % (ruta, k) if ruta else k)
    elif isinstance(valor, list):
        for i, v in enumerate(valor):
            yield from hojas(v, '%s[%d]' % (ruta, i))
    elif valor not in (None, '', [], {}):
        yield ruta, valor


def main():
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        sys.exit(1)
    url, numeros = sys.argv[1].rstrip('/'), sys.argv[2:]
    inv = cargar('inventario', 'listar-elementos-cotizados.py')
    auto = cargar('automatico', 'informe-comercial-automatico.py')
    usuario, clave = auto.credenciales()
    if not usuario or not clave:
        print('Faltan credenciales: cmdkey /generic:proenergy-costeo /user:admin /pass', file=sys.stderr)
        sys.exit(2)
    api = inv.ClienteApi(url)
    api.login(usuario, clave)

    for numero in numeros:
        r = api.get('/api/siigo/cotizaciones/%s/crudo' % urllib.parse.quote(numero))
        salida = RAIZ / 'reportes' / ('diagnostico-siigo-%s.json' % numero)
        salida.parent.mkdir(exist_ok=True)
        salida.write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding='utf-8')
        print('\n' + '=' * 78)
        print('%s  (id Siigo %s)   JSON completo: %s' % (numero, r.get('siigo_id'), salida))
        for origen in ('detalle', 'enListado'):
            doc = r.get(origen)
            print('\n--- %s: campos fuera de los ítems (el título debería estar aquí)' % origen)
            if not isinstance(doc, dict):
                print('   (no disponible: %s)' % doc)
                continue
            fuera = [(k, v) for k, v in hojas(doc) if not k.startswith('items')]
            for k, v in fuera:
                print('   %-38s %s' % (k, str(v)[:110]))
            items = [(k, v) for k, v in hojas(doc) if k.startswith('items')]
            print('   ... y %d valores dentro de items. Claves del primer ítem: %s'
                  % (len(items), sorted((doc.get('items') or [{}])[0].keys())))
        print('\n--- filtro updated_start de Siigo')
        for k, v in (r.get('pruebaUpdatedStart') or {}).items():
            print('   %-24s %s' % (k, v))


if __name__ == '__main__':
    main()
