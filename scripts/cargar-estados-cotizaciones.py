#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Saca de "Borrador" las cotizaciones que siguen ahi, para que entren en el
Dashboard, las Estadisticas y el Presupuesto.

Por que hacia falta: las 225 cotizaciones importadas de Siigo se crean como
Borrador y nadie las movio, y los KPIs solo cuentan las activas (Enviada,
Aprobada, Ejecutada, Cerrada). Con todo en Borrador el Dashboard se veia en
ceros por mas costos que se cargaran.

Que estado se pone y por que:
  - "Enviada" a las que no tienen factura vinculada. Es lo unico que se puede
    afirmar con certeza: son cotizaciones realmente emitidas en Siigo y enviadas
    al cliente. No se ponen como Aprobada ni Ejecutada porque no hay evidencia
    de eso, y afirmarlo falsearia la tasa de conversion.
  - Las que SI tienen factura ya quedaron como Ejecutada (ver
    marcar-cotizaciones-ejecutadas.py) y este script no las toca.

La fecha de aprobacion se deja VACIA a proposito. Es la base desde la que la app
calcula la fecha de pago esperada y la mora: ponerle una fecha inventada meteria
en la cartera plazos y vencimientos falsos. Sin fecha, la cotizacion cuenta en
el Dashboard pero queda como "Sin facturar" en cartera, que es la verdad.

ESCRIBE EN PRODUCCION. Simula por defecto; hay que pasar --ejecutar.
"""

import importlib.util
import os
import sys
from pathlib import Path

_d = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('inventario', _d / 'listar-elementos-cotizados.py')
inv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inv)

ESTADO_DESTINO = 'Enviada'
# No se tocan las que ya tienen un estado distinto de Borrador: alguien (o el
# script de ejecutadas) ya decidio sobre ellas.
ESTADO_ORIGEN = 'Borrador'


def main():
    ejecutar = '--ejecutar' in sys.argv
    cfg = inv.parsear_argumentos([a for a in sys.argv[1:] if a != '--ejecutar'])
    usuario, clave = os.environ.get('ADMIN_USERNAME'), os.environ.get('ADMIN_PASSWORD')
    if not usuario or not clave:
        print('Faltan ADMIN_USERNAME / ADMIN_PASSWORD.', file=sys.stderr)
        sys.exit(1)

    api = inv.ClienteApi(cfg['base_url'])
    api.login(usuario, clave)
    lista = api.get('/api/cotizaciones') or []

    objetivo = [c for c in lista if c.get('estado') == ESTADO_ORIGEN]
    por_estado = {}
    for c in lista:
        por_estado[c['estado']] = por_estado.get(c['estado'], 0) + 1

    valor = sum(float(c.get('precio_venta') or 0) for c in objetivo)
    costo = sum(float(c.get('costoInternoTotal') or 0) for c in objetivo)
    print(f'Estado actual: {por_estado}')
    print(f'\nSe moveran a "{ESTADO_DESTINO}": {len(objetivo)} cotizaciones')
    print(f'  valor ofertado que entra al Dashboard: ${valor:,.0f}')
    print(f'  costo interno que entra              : ${costo:,.0f}')
    print(f'  utilidad                             : ${valor - costo:,.0f}')
    if valor:
        print(f'  margen                               : {(1 - costo / valor) * 100:.1f}%')
    sin_costo = [c for c in objetivo if float(c.get('costoInternoTotal') or 0) <= 0]
    if sin_costo:
        print(f'\n  OJO: {len(sin_costo)} de esas todavia no tienen costo cargado.')

    if not ejecutar:
        print('\n(Simulacion: no se escribio nada. Agrega --ejecutar para aplicar)')
        return

    print('\nAplicando...')
    ok = fallos = 0
    for i, c in enumerate(objetivo, 1):
        try:
            det = api.get(f"/api/cotizaciones/{c['id']}")
            cot = det['cot']
            api.put(f"/api/cotizaciones/{c['id']}", {
                'cliente': cot['cliente'], 'descripcion': cot.get('descripcion') or '',
                'fecha_cotizacion': cot['fecha_cotizacion'],
                # Se conserva lo que hubiera; no se inventa una fecha de aprobacion.
                'fecha_aprobacion': cot.get('fecha_aprobacion'),
                'condicion_pago': cot.get('condicion_pago') or 'Contado',
                'dias_credito_otorgados': cot.get('dias_credito_otorgados') or 0,
                'precio_venta': cot['precio_venta'],
                'pct_anticipo': cot.get('pct_anticipo') or 0,
                'estado': ESTADO_DESTINO,
            })
            ok += 1
        except RuntimeError as e:
            fallos += 1
            if fallos <= 5:
                print(f"  FALLO {c['numero']}: {e}")
        if i % 20 == 0 or i == len(objetivo):
            print(f'  {i}/{len(objetivo)} ({ok} ok, {fallos} fallos)...', end='\r', flush=True)
    print(f'\n\nListo: {ok} cotizaciones movidas a {ESTADO_DESTINO}, {fallos} fallos.')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        print(f'\nERROR: {e}', file=sys.stderr)
        sys.exit(1)
