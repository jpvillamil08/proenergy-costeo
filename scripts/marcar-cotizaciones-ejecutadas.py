#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Marca como Ejecutadas las cotizaciones que tienen una factura de Siigo VINCULADA,
y les deja la cartera coherente con esa factura.

Solo toca las que tienen vinculo explicito factura -> cotizacion (el que arma
server/lib/facturas-vinculo.js leyendo el numero de cotizacion en las
observaciones). NO usa el cruce por cliente y monto: ese tiene falsos positivos
demostrados (la factura FV-2-434 calza a la vez con C-1-229 por su valor sin IVA
y con C-1-228 por su valor con IVA, y una factura no puede ser de dos
cotizaciones).

Que escribe en cada cotizacion:
  - estado             -> Ejecutada
  - fecha_aprobacion   -> la fecha de la factura. Es la base desde la que la app
                          calcula la fecha de pago esperada y la mora.
  - condicion_pago y dias_credito_otorgados -> deducidos del vencimiento real de
                          la factura (vencimiento - fecha). Si no hay
                          vencimiento, queda Contado.
  - un pago            -> por la parte efectivamente cobrada de la factura.
                          Se registra en proporcion, porque la factura viene con
                          IVA y la app lleva la cartera sobre el precio sin IVA:
                          si la factura esta pagada al 100%, el pago cubre el
                          100% del precio de venta. Sin esto, marcarlas como
                          ejecutadas las haria aparecer como cartera por cobrar
                          aunque ya esten pagadas.

ESCRIBE EN PRODUCCION. Simula por defecto; hay que pasar --ejecutar.

Uso:
    $env:ADMIN_USERNAME = "admin"
    $env:ADMIN_PASSWORD = "tu-clave"
    python scripts/marcar-cotizaciones-ejecutadas.py <URL>             # simula
    python scripts/marcar-cotizaciones-ejecutadas.py <URL> --ejecutar
"""

import importlib.util
import os
import sys
from datetime import date, datetime
from pathlib import Path

_d = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('inventario', _d / 'listar-elementos-cotizados.py')
inv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inv)


def dias_entre(a, b):
    try:
        return (date.fromisoformat(str(a)[:10]) - date.fromisoformat(str(b)[:10])).days
    except (ValueError, TypeError):
        return None


def main():
    ejecutar = '--ejecutar' in sys.argv
    cfg = inv.parsear_argumentos([a for a in sys.argv[1:] if a != '--ejecutar'])
    usuario, clave = os.environ.get('ADMIN_USERNAME'), os.environ.get('ADMIN_PASSWORD')
    if not usuario or not clave:
        print('Faltan ADMIN_USERNAME / ADMIN_PASSWORD.', file=sys.stderr)
        sys.exit(1)

    api = inv.ClienteApi(cfg['base_url'])
    api.login(usuario, clave)

    facturas = api.get('/api/facturas?desde=2000-01-01&hasta=2030-12-31') or []
    cotizaciones = {c['id']: c for c in (api.get('/api/cotizaciones') or [])}

    # Una cotizacion puede tener varias facturas (anticipo + saldo): se juntan.
    por_cot = {}
    for f in facturas:
        cid = f.get('cotizacion_id')
        if cid and cid in cotizaciones and not f.get('anulada'):
            por_cot.setdefault(cid, []).append(f)

    print(f'Cotizaciones con factura vinculada: {len(por_cot)}\n')
    print(f'{"COT":10} {"ESTADO":10} {"F.APROB":12} {"CREDITO":>8}  {"PRECIO":>14} {"PAGADO":>14}  FACTURA(S)')
    print('-' * 104)

    plan = []
    for cid, facs in sorted(por_cot.items(), key=lambda x: cotizaciones[x[0]]['numero']):
        c = cotizaciones[cid]
        facs.sort(key=lambda f: str(f.get('fecha') or ''))
        primera = facs[0]
        fecha_aprob = str(primera.get('fecha'))[:10]

        # Plazo de credito: del vencimiento real que reporta Siigo
        dias = None
        for f in facs:
            if f.get('vencimiento'):
                d = dias_entre(f['vencimiento'], f['fecha'])
                if d is not None and d >= 0:
                    dias = max(dias or 0, d)
        condicion = 'Credito' if dias else 'Contado'

        # Parte cobrada, en proporcion: la factura lleva IVA y la app lleva la
        # cartera sobre el precio sin IVA.
        total_fac = sum(float(f.get('total') or 0) for f in facs)
        saldo_fac = sum(float(f.get('saldo') or 0) for f in facs)
        precio = float(c.get('precio_venta') or 0)
        pagado = 0.0
        if total_fac > 0 and precio > 0:
            pagado = round(precio * (total_fac - saldo_fac) / total_fac, 2)

        plan.append({'cot': c, 'fecha_aprob': fecha_aprob, 'dias': dias or 0,
                     'condicion': condicion, 'pagado': pagado, 'facturas': facs})
        print(f"{c['numero']:10} {'Ejecutada':10} {fecha_aprob:12} {(str(dias)+'d') if dias else 'contado':>8}"
              f"  {precio:>14,.0f} {pagado:>14,.0f}  {', '.join(f['numero'] for f in facs)}")

    if not ejecutar:
        print(f'\n(Simulacion: {len(plan)} cotizaciones. Agrega --ejecutar para aplicar)')
        return

    print('\nAplicando...')
    ok = fallos = pagos_ok = 0
    for p in plan:
        c = p['cot']
        try:
            det = api.get(f"/api/cotizaciones/{c['id']}")
            cot = det['cot']
            api.put(f"/api/cotizaciones/{c['id']}", {
                'cliente': cot['cliente'], 'descripcion': cot.get('descripcion') or '',
                'fecha_cotizacion': cot['fecha_cotizacion'],
                'fecha_aprobacion': p['fecha_aprob'],
                'condicion_pago': p['condicion'],
                'dias_credito_otorgados': p['dias'],
                'precio_venta': cot['precio_venta'],
                'pct_anticipo': cot.get('pct_anticipo') or 0,
                'estado': 'Ejecutada',
            })
            ok += 1
            # Registra lo cobrado, si no hay pagos ya cargados
            if p['pagado'] > 0 and not (det.get('pagos') or []):
                ultima = max(p['facturas'], key=lambda f: str(f.get('fecha') or ''))
                api.post_json(f"/api/cotizaciones/{c['id']}/pagos", {
                    'fecha': str(ultima.get('fecha'))[:10],
                    'valor': p['pagado'],
                    'medio_pago': 'Transferencia',
                    'referencia': ', '.join(f['numero'] for f in p['facturas']),
                    'observacion': 'Registrado desde la factura de Siigo (parte cobrada)',
                })
                pagos_ok += 1
        except RuntimeError as e:
            fallos += 1
            print(f"  FALLO {c['numero']}: {e}")
    print(f'\nListo: {ok} cotizaciones marcadas Ejecutada, {pagos_ok} con pago registrado, {fallos} fallos.')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as e:
        print(f'\nERROR: {e}', file=sys.stderr)
        sys.exit(1)
