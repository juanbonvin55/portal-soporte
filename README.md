# Portal de soporte para clientes — v1.1.0

Aplicación web para recibir y gestionar solicitudes de soporte. Incluye un portal de clientes con cuentas propias, un formulario de tickets con imágenes adjuntas y un panel administrativo privado. Está pensada para ejecutarse localmente en Windows con VS Code y Node.js.

## Novedades de la versión 1.1.0

- Tipografía y controles más grandes para mejorar la lectura y el uso con mouse o pantalla táctil.
- Registro de clientes con nombre, empresa, correo y contraseña.
- Inicio y cierre de sesión de clientes.
- Perfil editable y cambio de contraseña.
- Cada ticket queda asociado a la cuenta que lo creó.
- Los clientes pueden consultar únicamente sus propios tickets.
- Los clientes pueden editar título, categoría, resumen, descripción, teléfono y agregar más imágenes mientras el ticket esté en estado **Nuevo**.
- Cuando el equipo de soporte cambia el estado a **En proceso**, **En espera** o **Resuelto**, el contenido del ticket queda bloqueado para edición del cliente.
- Adjuntos de hasta 4 imágenes PNG, JPG o WebP, de 4 MB por imagen y 12 MB en total por envío.
- Los adjuntos se guardan fuera de la carpeta pública y requieren autorización para descargarse o visualizarse.
- El panel administrativo mantiene búsqueda, filtros, cambios de estado/prioridad, notas internas privadas y exportación CSV. También muestra la cuenta del cliente y las imágenes recibidas.
- La base de datos creada por la versión 1.0.0 se migra al iniciar, agregando el vínculo entre tickets y cuentas. Los tickets antiguos permanecen visibles para administración, pero no se asignan automáticamente a cuentas nuevas.

## Requisitos

- Node.js **22.13 o superior**. Se recomienda instalar una versión LTS desde https://nodejs.org/en/download/.
- VS Code (recomendado).
- No hace falta ejecutar `npm install`: el proyecto utiliza módulos incluidos en Node.js y no requiere paquetes externos.

Comprobá que Node.js y npm estén disponibles en la terminal:

```powershell
node -v
npm -v
```

## Iniciar en Windows con VS Code

1. Descomprimí la carpeta `portal-soporte` en un lugar fácil de encontrar.
2. Abrí VS Code y elegí **Archivo → Abrir carpeta**. Seleccioná `portal-soporte`.
3. Abrí una terminal con **Terminal → Nuevo terminal**.
4. Ejecutá:

   ```powershell
   npm start
   ```

5. En el primer inicio se crea el archivo local `.env` y aparece en la terminal una contraseña administrativa inicial. Guardala. También queda almacenada en `.env`.
6. Abrí en el navegador:
   - Portal de clientes: `http://localhost:3000`
   - Panel administrativo: `http://localhost:3000/admin`
   - Aviso de privacidad: `http://localhost:3000/privacidad`

Para detener el servidor, volvé a la terminal y presioná `Ctrl + C`.

## Cómo funciona el portal de clientes

1. El cliente crea una cuenta con nombre, empresa, correo y una contraseña de al menos 12 caracteres.
2. Inicia sesión y puede crear un ticket. El formulario sigue solicitando nombre, empresa, correo de contacto, tipo, título, resumen y descripción detallada.
3. Puede adjuntar capturas o fotos PNG, JPG o WebP.
4. En **Mis tickets** puede abrir cada solicitud, consultar su estado y ver los archivos adjuntos.
5. Mientras un ticket siga en estado **Nuevo**, puede editar su contenido y sumar nuevas imágenes. Una vez que soporte comienza a gestionarlo y cambia el estado, la edición queda bloqueada.
6. Desde **Editar mis datos** puede actualizar nombre, empresa y correo. Desde **Cambiar contraseña** puede renovar su clave.

Las contraseñas de cliente se almacenan mediante `scrypt` con una sal aleatoria individual. La aplicación no las guarda como texto legible. Las sesiones usan cookies HttpOnly y SameSite Strict. Esto no reemplaza una revisión de seguridad profesional antes de exponer el portal a internet.

## Panel administrativo

1. Entrá en `http://localhost:3000/admin`.
2. Usuario: `administrador`.
3. Contraseña: la que apareció al iniciar el servidor por primera vez, o la definida en `ADMIN_PASSWORD` dentro de `.env`.
4. Abrí un ticket para leer el detalle, ver los datos de la cuenta y las imágenes adjuntas.
5. Cambiá estado/prioridad y agregá notas internas. Las notas internas no son visibles para el cliente.

## Datos locales y copias de seguridad

- Base de datos: `data/soporte.sqlite`.
- Imágenes adjuntas: `data/uploads/`.
- Configuración y secretos: `.env`.

No compartas ni publiques esos archivos: contienen credenciales y/o información privada de clientes. Para hacer una copia local, detené el servidor con `Ctrl + C` y copiá la base SQLite y la carpeta `data/uploads` a una ubicación protegida. Mantené ambos elementos juntos para conservar los adjuntos relacionados con los tickets.

## Subir el proyecto a GitHub desde VS Code

GitHub sirve para guardar el código y llevar un historial de cambios. **Subir el proyecto a GitHub no lo publica como portal operativo**: para que los clientes ingresen desde internet después habrá que desplegar el servidor Node.js en un hosting adecuado.

### A. Preparar Git

1. Creá o ingresá a tu cuenta de GitHub: https://github.com/.
2. Instalá Git para Windows si todavía no lo tenés: https://git-scm.com/downloads/win.
3. Cerrá y volvé a abrir VS Code.
4. En la terminal ejecutá:

   ```powershell
   git --version
   ```

   Si aparece un número de versión, Git está disponible.

### B. Crear el repositorio vacío en GitHub

1. En GitHub, seleccioná **New repository**.
2. Como nombre podés usar `portal-soporte`.
3. Elegí **Private** si el código es interno de tu organización. Aunque los datos locales están excluidos, para un sistema de soporte suele ser más prudente empezar con el repositorio privado.
4. No marques las opciones de agregar README, `.gitignore` ni licencia: el proyecto ya trae esos archivos.
5. Seleccioná **Create repository** y dejá abierta la página que muestra la dirección del repositorio.

### C. Publicar el código desde VS Code

Asegurate de tener abierta la carpeta raíz `portal-soporte` en VS Code. En **Terminal → Nuevo terminal**, ejecutá estos comandos uno por uno. La primera vez, configurá el nombre y correo que Git usará para identificar tus registros (podés usar el correo `noreply` que ofrece GitHub si preferís no mostrar tu dirección personal):

```powershell
git config --global user.name "Tu nombre"
git config --global user.email "TU-CORREO-DE-GITHUB"

# 1. Inicializar Git en la carpeta del proyecto
git init

# 2. Revisar qué archivos se van a incluir
git status

# 3. Preparar los archivos
git add .

# 4. Volver a revisar lo preparado
git status

# 5. Crear el primer registro de cambios
git commit -m "Crear portal de soporte v1.1.0"

# 6. Nombrar la rama principal
git branch -M main

# 7. Vincular con el repositorio de GitHub (reemplazá la dirección)
git remote add origin https://github.com/TU-USUARIO/portal-soporte.git

# 8. Subir el código
git push -u origin main
```

GitHub puede abrir una ventana del navegador para que autorices el acceso. Seguí ese inicio de sesión.

### D. Comprobar que quedó bien

Volvé a la página del repositorio en GitHub y actualizala. Deberías ver `server.js`, `public/`, `package.json`, `.gitignore`, `README.md` y los demás archivos del proyecto.

Antes de subir, `git status` no debe mostrar `.env`, `data/soporte.sqlite` ni archivos de `data/uploads/`. Esos elementos están excluidos por `.gitignore`. **Nunca subas contraseñas, archivos `.env`, bases de datos reales ni capturas de clientes.**

### E. Subir cambios futuros

Cada vez que modifiques el proyecto y quieras guardar esa versión en GitHub:

```powershell
git add .
git status
git commit -m "Describir el cambio realizado"
git push
```

Si Git dice que `origin` ya existe, no repitas `git remote add origin`; comprobá la dirección con `git remote -v`.

## Antes de usarlo con clientes reales

Esta versión es una base de trabajo y prueba; todavía no debe exponerse directamente a internet sin preparación adicional:

- Completá `public/privacidad.html` reemplazando todos los campos entre corchetes. El texto es una plantilla y no asesoramiento legal.
- Publicá el servicio detrás de HTTPS y configurá `NODE_ENV=production`, `ADMIN_PASSWORD` y `SESSION_SECRET` como variables de entorno del hosting. No uses el `.env` local en producción.
- Confirmá que el hosting tenga almacenamiento persistente. La base SQLite y `data/uploads/` se guardan en disco; algunos hostings eliminan los archivos locales al desplegar.
- Configurá copias de seguridad y controles de acceso al servidor.
- Esta versión no incluye confirmación de correo, recuperación de contraseña ni notificaciones automáticas. Antes de ofrecer cuentas a clientes reales conviene agregar verificación de correo y un proceso seguro de recuperación de cuenta.
- El límite básico de solicitudes por IP se almacena en memoria y se reinicia con el proceso. En un despliegue público conviene complementarlo con rate limiting en el proxy/hosting, monitoreo y protección anti-spam.
- Definí el plazo de conservación de tickets y archivos y el procedimiento para atender solicitudes de los titulares de datos.

La interfaz pública es responsive y utiliza tamaños de texto y controles mayores. Aun así, probá el portal con zoom del navegador al 200 %, teclado y distintas pantallas antes de publicarlo.
