# Conectar el correo de Outlook a la plataforma

Guía para el **administrador de Microsoft 365 de Proenergy**. Se hace una sola vez y toma unos 15 minutos.

## Qué se va a conectar

La plataforma de costeo (Railway) lee **cada hora** dos buzones:

- `jose.villamil@proenergyco.com`
- `ventasproenergy@proenergyco.com`

Con lo que encuentra, hace tres cosas:

- Registra las cotizaciones que se envían fuera de Siigo.
- Asocia las órdenes de compra que llegan de los clientes a su cotización y a su factura.
- Arma un buzón con las solicitudes de clientes, las invitaciones a licitar y las cotizaciones de proveedores.

**El permiso es solo de lectura** (`Mail.Read`). La plataforma no envía, no borra y no mueve correos, y el paso 4 la limita a esos dos buzones.

## 1. Registrar la aplicación

1. Entrar a <https://entra.microsoft.com> con una cuenta de administrador.
2. **Identidad → Aplicaciones → Registros de aplicaciones → Nuevo registro**.
3. Nombre: `Plataforma Costeo PROENERGY`. Tipo de cuenta: *Solo las cuentas de este directorio organizativo*. Sin URI de redirección. **Registrar**.
4. En la página de la aplicación, copiar:
   - **Id. de aplicación (cliente)**, que es el `MS_CLIENT_ID`;
   - **Id. de directorio (inquilino)**, que es el `MS_TENANT_ID`.

## 2. Dar el permiso de lectura de correo

1. **Permisos de API → Agregar un permiso → Microsoft Graph → Permisos de aplicación**.
2. Buscar y marcar **`Mail.Read`**. Agregar.
3. Pulsar **Conceder consentimiento de administrador para Proenergy** y confirmar. El estado debe quedar en verde.

## 3. Crear el secreto

1. **Certificados y secretos → Secretos de cliente → Nuevo secreto de cliente**.
2. Descripción: `Railway`. Vencimiento: 24 meses. Anotar la fecha para renovarlo.
3. Copiar el **Valor** de inmediato: después no se vuelve a mostrar. Es el `MS_CLIENT_SECRET`.

## 4. Limitar la aplicación a los dos buzones (recomendado)

Sin este paso, `Mail.Read` de aplicación permite leer **todos** los buzones de la empresa. Para dejarla solo con los dos buzones, desde PowerShell con el módulo de Exchange Online:

```powershell
Connect-ExchangeOnline
New-DistributionGroup -Name "Plataforma Costeo - buzones" -Type Security -Members jose.villamil@proenergyco.com,ventasproenergy@proenergyco.com
New-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> -PolicyScopeGroupId "Plataforma Costeo - buzones" -AccessRight RestrictAccess -Description "Solo buzones de ventas"
Test-ApplicationAccessPolicy -Identity jose.villamil@proenergyco.com -AppId <MS_CLIENT_ID>   # debe decir Granted
Test-ApplicationAccessPolicy -Identity otro.usuario@proenergyco.com -AppId <MS_CLIENT_ID>    # debe decir Denied
```

Microsoft recomienda ahora *RBAC para aplicaciones* de Exchange Online en lugar de `ApplicationAccessPolicy`. Cualquiera de los dos sirve; lo importante es que la prueba del otro usuario diga **Denied**.

## 5. Cargar las variables en Railway

En Railway, servicio de la plataforma → **Variables**, agregar:

| Variable | Valor |
|---|---|
| `MS_TENANT_ID` | Id. de directorio (paso 1) |
| `MS_CLIENT_ID` | Id. de aplicación (paso 1) |
| `MS_CLIENT_SECRET` | Valor del secreto (paso 3) |
| `CORREO_BUZONES` | `jose.villamil@proenergyco.com,ventasproenergy@proenergyco.com` |

Railway reinicia el servicio solo. También debe existir la clave de IA que ya usa el asistente (`GEMINI_API_KEY` o `ANTHROPIC_API_KEY`): con ella se leen los PDF y Word de los correos.

## 6. Probar

En la plataforma, menú **Buzón** → **Leer correo ahora**:

- La primera lectura revisa los **últimos 30 días** y puede tardar unos minutos.
- En la pestaña **Registro del correo** se ve qué se leyó y cómo se clasificó.
- Después corre sola cada hora en punto.

## Qué información sale de la empresa

Solo los correos que pasan el filtro previo (con palabras como cotización, oferta, orden de compra o licitación, o con un PDF o Word adjunto) se envían, con sus adjuntos, al proveedor de IA configurado (Google Gemini o Anthropic) para extraer los datos. Los boletines y las respuestas automáticas se descartan antes.
