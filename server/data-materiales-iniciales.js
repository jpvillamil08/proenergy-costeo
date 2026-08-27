'use strict';
// Catalogo inicial de materiales y precios por proveedor, cargado una sola vez
// (ver migracion en db.js) a partir del archivo Precios_Proveedores.xlsx que
// suministro PROENERGY el 25/08/2026. Los precios son "Precio Unitario" (sin IVA);
// precio_con_iva se guarda solo como referencia informativa (19%% ya calculado
// en el archivo original).
module.exports = [
  {
    "descripcion": "Soldadura Cadwell 115",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 15000.0,
        "precio_con_iva": 17850.0
      }
    ]
  },
  {
    "descripcion": "Hidrosolta (10 KL)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 14000.0,
        "precio_con_iva": 16660.0
      }
    ]
  },
  {
    "descripcion": "Cable desnudo # 2",
    "unidad": "UND/MTS",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 21043.0,
        "precio_con_iva": 25041.17
      },
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 27700.0,
        "precio_con_iva": 32963.0
      },
      {
        "proveedor": "Herrajes y Cables",
        "precio_unitario": 29500.0,
        "precio_con_iva": 35105.0
      }
    ]
  },
  {
    "descripcion": "Cable desnudo # 2/0 cobre",
    "unidad": "MTS",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 49670.0,
        "precio_con_iva": 59107.3
      }
    ]
  },
  {
    "descripcion": "Coraza metalica LT 1",
    "unidad": "MTS",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 7800.0,
        "precio_con_iva": 9282.0
      }
    ]
  },
  {
    "descripcion": "Conector cuna 4/0-4/0 (ref. 4/0-4/0)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 18000.0,
        "precio_con_iva": 21420.0
      }
    ]
  },
  {
    "descripcion": "Conector cuna 2-2 / 2-1/0-2-4 (ref. CADC-103)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 9000.0,
        "precio_con_iva": 10710.0
      },
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 6667.0,
        "precio_con_iva": 7933.73
      }
    ]
  },
  {
    "descripcion": "Terminal ec. anillo amarillo (10-12AWG)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 400.0,
        "precio_con_iva": 476.0
      }
    ]
  },
  {
    "descripcion": "Terminal ec. anillo amarillo ojo 1/2 (10-12)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 750.0,
        "precio_con_iva": 892.5
      }
    ]
  },
  {
    "descripcion": "Conector cuna tipo A (ref. CDC-A-VI)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 7500.0,
        "precio_con_iva": 8925.0
      },
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 7900.0,
        "precio_con_iva": 9401.0
      }
    ]
  },
  {
    "descripcion": "Conector cuna 1/0-1/0 (ref. CADC-20B)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 13000.0,
        "precio_con_iva": 15470.0
      }
    ]
  },
  {
    "descripcion": "Conector cuna 4/0-1/0 (ref. CADC208)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 12933.0,
        "precio_con_iva": 15390.27
      }
    ]
  },
  {
    "descripcion": "Platina para TC y TP",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 16800.0,
        "precio_con_iva": 19992.0
      },
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 16500.0,
        "precio_con_iva": 19635.0
      },
      {
        "proveedor": "Herrajes y Cables",
        "precio_unitario": 21200.0,
        "precio_con_iva": 25228.0
      }
    ]
  },
  {
    "descripcion": "Caja primaria 15/27KV 100 AMP M&D/Proteck",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 220000.0,
        "precio_con_iva": 261800.0
      }
    ]
  },
  {
    "descripcion": "Caja primaria 38KV 100 AMP M&D/Proteck",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 367500.0,
        "precio_con_iva": 437325.0
      }
    ]
  },
  {
    "descripcion": "Varilla C/Well Cu.Cu 5/8 x 2.40M",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 265000.0,
        "precio_con_iva": 315350.0
      }
    ]
  },
  {
    "descripcion": "Terminal premold 35KV 1/0-350 ext MSTO1C-36N (Prysmian)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 891000.0,
        "precio_con_iva": 1060290.0
      }
    ]
  },
  {
    "descripcion": "Cruceta metalica autosoportada (~2.4m)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 162000.0,
        "precio_con_iva": 192780.0
      },
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 168027.0,
        "precio_con_iva": 199952.13
      },
      {
        "proveedor": "Herrajes y Cables",
        "precio_unitario": 198000.0,
        "precio_con_iva": 235620.0
      }
    ]
  },
  {
    "descripcion": "Cable control 4x12",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 21000.0,
        "precio_con_iva": 24990.0
      },
      {
        "proveedor": "Herrajes y Cables",
        "precio_unitario": 38000.0,
        "precio_con_iva": 45220.0
      }
    ]
  },
  {
    "descripcion": "Cable control 6x12",
    "unidad": "MTS/UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 29950.0,
        "precio_con_iva": 35640.5
      },
      {
        "proveedor": "Herrajes y Cables",
        "precio_unitario": 42000.0,
        "precio_con_iva": 49980.0
      }
    ]
  },
  {
    "descripcion": "Cinta Band-it / Bandix 3/4",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 3550.0,
        "precio_con_iva": 4224.5
      },
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 3467.0,
        "precio_con_iva": 4125.73
      },
      {
        "proveedor": "Herrajes y Cables",
        "precio_unitario": 4000.0,
        "precio_con_iva": 4760.0
      }
    ]
  },
  {
    "descripcion": "Hebilla Band-it / Bandix 3/4",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 650.0,
        "precio_con_iva": 773.5
      },
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 980.0,
        "precio_con_iva": 1166.2
      }
    ]
  },
  {
    "descripcion": "Esparrago 5/8 x 12",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 5400.0,
        "precio_con_iva": 6426.0
      },
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 6000.0,
        "precio_con_iva": 7140.0
      }
    ]
  },
  {
    "descripcion": "Esparrago 5/8 x 16",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 6500.0,
        "precio_con_iva": 7735.0
      },
      {
        "proveedor": "Herrajes y Cables",
        "precio_unitario": 12500.0,
        "precio_con_iva": 14875.0
      }
    ]
  },
  {
    "descripcion": "Conector recto LT 1",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 4200.0,
        "precio_con_iva": 4998.0
      },
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 5493.0,
        "precio_con_iva": 6536.67
      }
    ]
  },
  {
    "descripcion": "Kit tierra distribucion 12mts c/varilla 1/2x2 (media tension)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 215000.0,
        "precio_con_iva": 255850.0
      }
    ]
  },
  {
    "descripcion": "Bloque de prueba (Farcel 1MED)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 350000.0,
        "precio_con_iva": 416500.0
      },
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 350000.0,
        "precio_con_iva": 416500.0
      }
    ]
  },
  {
    "descripcion": "L para pararrayo de transformador",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 13000.0,
        "precio_con_iva": 15470.0
      }
    ]
  },
  {
    "descripcion": "Cable THHN # 2",
    "unidad": "MTS",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 22665.0,
        "precio_con_iva": 26971.35
      }
    ]
  },
  {
    "descripcion": "Terminal barril largo # 2 orificio de 1/2",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 4700.0,
        "precio_con_iva": 5593.0
      }
    ]
  },
  {
    "descripcion": "Breaker ind. 250AMP 440V M.Gerin (EZC250N)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 550000.0,
        "precio_con_iva": 654500.0
      }
    ]
  },
  {
    "descripcion": "Conector de perforacion CDP-120-120",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 15000.0,
        "precio_con_iva": 17850.0
      },
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 16733.0,
        "precio_con_iva": 19912.27
      }
    ]
  },
  {
    "descripcion": "Conector tubular VCP # 2",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 2800.0,
        "precio_con_iva": 3332.0
      }
    ]
  },
  {
    "descripcion": "Tubo conduit galv. 1\" c/union (Fuji)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 35900.0,
        "precio_con_iva": 42721.0
      }
    ]
  },
  {
    "descripcion": "Sika Bomm",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 45000.0,
        "precio_con_iva": 53550.0
      }
    ]
  },
  {
    "descripcion": "Breaker multi-9 bipolar 20amp Chint (NB1-63 2P20A)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 27300.0,
        "precio_con_iva": 32487.0
      }
    ]
  },
  {
    "descripcion": "Terminal Cu estanado 2AWG 1H B/L 130A 1/2 hueco grande",
    "unidad": "unidad",
    "precios": [
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 4000.0,
        "precio_con_iva": 4760.0
      }
    ]
  },
  {
    "descripcion": "Cortacircuito 100AMP 27KV",
    "unidad": "unidad",
    "precios": [
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 219938.0,
        "precio_con_iva": 261726.22
      }
    ]
  },
  {
    "descripcion": "Herraje L para pararrayo / cortacircuito 1/8",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 16328.0,
        "precio_con_iva": 19430.32
      }
    ]
  },
  {
    "descripcion": "Coraza liquid tight 1",
    "unidad": "metro",
    "precios": [
      {
        "proveedor": "Electricos Murillo",
        "precio_unitario": 7800.0,
        "precio_con_iva": 9282.0
      },
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 8131.0,
        "precio_con_iva": 9675.89
      }
    ]
  },
  {
    "descripcion": "Terminal ojo amarilla D18.4mm 10-12AWG 5/16 EBC",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 34251.0,
        "precio_con_iva": 40758.69
      }
    ]
  },
  {
    "descripcion": "Caja policarbonato para medidor 410x260x186 cms",
    "unidad": "unidad",
    "precios": [
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 86666.0,
        "precio_con_iva": 103132.54
      }
    ]
  },
  {
    "descripcion": "Gabinete metalico certificado para 2 medidores (660x450x250)",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Red+Electric",
        "precio_unitario": 476000.0,
        "precio_con_iva": 566440.0
      }
    ]
  },
  {
    "descripcion": "Herraje soporte en L pequeno",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Herrajes y Cables",
        "precio_unitario": 18000.0,
        "precio_con_iva": 21420.0
      }
    ]
  },
  {
    "descripcion": "Terminal ponchar #2 ojo de 1/2",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Herrajes y Cables",
        "precio_unitario": 7000.0,
        "precio_con_iva": 8330.0
      }
    ]
  },
  {
    "descripcion": "Terminal ajo #12",
    "unidad": "UND",
    "precios": [
      {
        "proveedor": "Herrajes y Cables",
        "precio_unitario": 600.0,
        "precio_con_iva": 714.0
      }
    ]
  }
];
