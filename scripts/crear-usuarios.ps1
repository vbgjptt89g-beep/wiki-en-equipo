#Requires -Version 5.1
<#
    Crea los usuarios y departamentos de Grupo Comidas en la wiki de producción.

    Qué hace, en orden y sin borrar nada nunca:
      1. Crea el administrador con POST /api/auth/bootstrap (solo funciona si la base no tiene ningún usuario).
         Si la base ya tiene usuarios, no pasa nada: avisa y sigue.
      2. Entra a la wiki como administrador para obtener un token.
      3. Crea los departamentos que falten (Contabilidad y Compras).
      4. Crea los usuarios que falten. Si un correo ya existe, lo avisa y NO lo toca.

    Cómo se corre (PowerShell, en Windows):
        cd <carpeta del repo>
        powershell -ExecutionPolicy Bypass -File .\scripts\crear-usuarios.ps1 -BackendUrl "https://<tu-backend>.vercel.app"
    Te pedirá el BOOTSTRAP_SECRET (el mismo de Vercel). No se escribe en ningún archivo.
#>
[CmdletBinding()]
param(
    # Dirección del backend en producción. Cámbiala por la del proyecto wiki-en-equipo-backend en Vercel.
    [string]$BackendUrl = "https://wiki-en-equipo-backend.vercel.app",
    # Contraseña de todos los usuarios (decisión del equipo; el backend pide mínimo 8 caracteres).
    [string]$Password = "12345abc"
)

$ErrorActionPreference = "Stop"
# Mostrar las tildes bien en la consola de Windows.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$backend = $BackendUrl.TrimEnd("/")

# La contraseña del bootstrap se pide aquí y solo vive en memoria. En una máquina de confianza también
# se puede pasar con la variable de entorno BOOTSTRAP_SECRET (útil para pruebas), sin que se guarde en disco.
$bootstrapSecret = $env:BOOTSTRAP_SECRET
if ([string]::IsNullOrWhiteSpace($bootstrapSecret)) {
    $bootstrapSecure = Read-Host -Prompt "BOOTSTRAP_SECRET (el de Vercel, Production)" -AsSecureString
    $bootstrapSecret = [System.Net.NetworkCredential]::new("", $bootstrapSecure).Password
}
if ([string]::IsNullOrWhiteSpace($bootstrapSecret)) { Write-Host "Cancelado: no escribiste el BOOTSTRAP_SECRET." -ForegroundColor Red; exit 1 }

# Definición de los departamentos y los usuarios pedidos.
# Se identifica cada departamento por su "slug" (sin tildes), para no depender de cómo se lean las tildes
# según la configuración de Windows.
$departments = @("Contabilidad", "Compras")
$users = @(
    [pscustomobject]@{ Name = "Admin Contabilidad"; Email = "contabilidadwiki@grupocomidas.com"; Role = "DEPARTMENT_ADMIN"; DepartmentSlug = "contabilidad"; DepartmentLabel = "Contabilidad" },
    [pscustomobject]@{ Name = "Usuario Tecnología"; Email = "tecnologiawiki@grupocomidas.com"; Role = "USER"; DepartmentSlug = "tecnologia"; DepartmentLabel = "Tecnología" },
    [pscustomobject]@{ Name = "Usuario Compras"; Email = "compraswiki@grupocomidas.com"; Role = "USER"; DepartmentSlug = "compras"; DepartmentLabel = "Compras" }
)
$adminEmail = "adminwiki@grupocomidas.com"

function Get-Slug {
    # Igual que el backend (minúsculas, sin tildes, solo letras y números), pero además quita los guiones:
    # así "tecnolog-a" y "tecnologia" se consideran el mismo departamento.
    param([string]$Text)
    $normalized = $Text.Normalize([System.Text.NormalizationForm]::FormD)
    $ascii = -join ($normalized.ToCharArray() | Where-Object { [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($_) -ne [System.Globalization.UnicodeCategory]::NonSpacingMark } | Where-Object { $_ -match '[\x00-\x7F]' })
    $slug = ($ascii.ToLower() -replace '[^a-z0-9]+', '')
    return $slug
}

function Invoke-Api {
    # Llama a la API y devuelve un objeto { Status; Body }. Nunca lanza por un 4xx.
    # El cuerpo va como bytes UTF-8 explícitos para que las tildes y nombres lleguen bien.
    param([string]$Method, [string]$Path, [object]$Body, [string]$Token)
    $headers = @{ "Content-Type" = "application/json; charset=utf-8" }
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }
    $params = @{ Method = $Method; Uri = "$backend$Path"; Headers = $headers; UseBasicParsing = $true; ErrorAction = "Stop" }
    if ($null -ne $Body) { $params["Body"] = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 6 -Compress)) }
    try {
        $res = Invoke-WebRequest @params
        $text = if ($res.RawContentStream) { [System.Text.Encoding]::UTF8.GetString($res.RawContentStream.ToArray()) } else { $res.Content }
        $parsed = if ($text) { $text | ConvertFrom-Json } else { $null }
        return [pscustomobject]@{ Status = [int]$res.StatusCode; Body = $parsed }
    } catch {
        $status = 0; $parsed = $null
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                $parsed = $reader.ReadToEnd() | ConvertFrom-Json
            } catch {}
        }
        return [pscustomobject]@{ Status = $status; Body = $parsed }
    }
}

function Fail {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Wiki Grupo Comidas: usuarios y departamentos" -ForegroundColor Cyan
Write-Host "Backend: $backend" -ForegroundColor DarkGray
Write-Host ""

# 0. Comprobar que el backend responde.
$health = Invoke-Api -Method "GET" -Path "/health"
if ($health.Status -ne 200) { Fail "El backend no respondió en /health (código $($health.Status)). Revisa la dirección: $backend" }
Write-Host "Backend en línea." -ForegroundColor Green

# 1. Administrador (bootstrap). Solo funciona con la base vacía.
$adminPayload = @{ name = "Administrador"; email = $adminEmail; password = $Password; departmentName = "Tecnología"; secret = $bootstrapSecret }
$bootstrap = Invoke-Api -Method "POST" -Path "/api/auth/bootstrap" -Body $adminPayload
if ($bootstrap.Status -eq 201) {
    Write-Host "Administrador creado ($adminEmail)." -ForegroundColor Green
} elseif ($bootstrap.Status -eq 409) {
    Write-Host "La base ya tenía usuarios: no creo el administrador (el que ya existe sirve)." -ForegroundColor Yellow
} elseif ($bootstrap.Status -eq 403) {
    Fail "El BOOTSTRAP_SECRET no coincide con el del backend."
} elseif ($bootstrap.Status -eq 429) {
    Fail "Demasiados intentos de configuración inicial. Espera unos minutos y vuelve a ejecutar el script."
} else {
    Fail "No pude crear el administrador (código $($bootstrap.Status)). Revisa los registros del backend."
}

# 2. Entrar como administrador.
$login = Invoke-Api -Method "POST" -Path "/api/auth/login" -Body @{ email = $adminEmail; password = $Password }
if ($login.Status -ne 200 -or -not $login.Body.token) {
    Write-Host "No pude entrar como administrador (código $($login.Status))." -ForegroundColor Red
    $hint = if ($login.Body.error.message) { $login.Body.error.message } else { "¿Existe el administrador y su contraseña es '$Password'?" }
    Fail $hint
}
$token = $login.Body.token
Write-Host "Sesión iniciada como administrador." -ForegroundColor Green

# 3. Departamentos: crear los que falten.
$existingDepartments = @{}
$list = Invoke-Api -Method "GET" -Path "/api/departments" -Token $token
if ($list.Status -eq 200) { foreach ($d in $list.Body.departments) { $existingDepartments[(Get-Slug $d.slug)] = $d.id } }
# El administrador pertenece a Tecnología (la crea el bootstrap); su departamento es la referencia exacta.
$me = Invoke-Api -Method "GET" -Path "/api/auth/me" -Token $token
if ($me.Status -eq 200 -and $me.Body.user.department.name) { $existingDepartments[(Get-Slug $me.Body.user.department.name)] = $me.Body.user.departmentId }
foreach ($depName in $departments) {
    $slug = Get-Slug $depName
    if ($existingDepartments.ContainsKey($slug)) {
        Write-Host "Departamento '$depName' ya existe." -ForegroundColor Yellow
        continue
    }
    $created = Invoke-Api -Method "POST" -Path "/api/departments" -Body @{ name = $depName } -Token $token
    if ($created.Status -eq 201) {
        $existingDepartments[(Get-Slug $created.Body.department.slug)] = $created.Body.department.id
        Write-Host "Departamento '$depName' creado." -ForegroundColor Green
    } else {
        Write-Host "No pude crear el departamento '$depName' (código $($created.Status))." -ForegroundColor Red
    }
}

# La Tecnología del administrador ya existe; si aun así no aparece, vuelvo a leer los departamentos.
if (-not $existingDepartments.ContainsKey("tecnologia")) {
    $refresh = Invoke-Api -Method "GET" -Path "/api/departments" -Token $token
    if ($refresh.Status -eq 200) { foreach ($d in $refresh.Body.departments) { $existingDepartments[(Get-Slug $d.slug)] = $d.id } }
}

# 4. Usuarios: crear los que falten, sin tocar los existentes.
$existingEmails = @{}
$userList = Invoke-Api -Method "GET" -Path "/api/users" -Token $token
if ($userList.Status -eq 200) { foreach ($u in $userList.Body.users) { $existingEmails[$u.email.ToLower()] = $true } }

$summary = @()
foreach ($u in $users) {
    if ($existingEmails.ContainsKey($u.Email.ToLower())) {
        Write-Host "Usuario $($u.Email) ya existe: no lo toco." -ForegroundColor Yellow
        $summary += [pscustomobject]@{ Usuario = $u.Name; Correo = $u.Email; Resultado = "Ya existía" }
        continue
    }
    $depId = $existingDepartments[(Get-Slug $u.DepartmentSlug)]
    if (-not $depId) {
        Write-Host "Falta el departamento '$($u.DepartmentLabel)': no puedo crear $($u.Email)." -ForegroundColor Red
        $summary += [pscustomobject]@{ Usuario = $u.Name; Correo = $u.Email; Resultado = "Falta el departamento" }
        continue
    }
    $newUser = Invoke-Api -Method "POST" -Path "/api/users" -Body @{ name = $u.Name; email = $u.Email; password = $Password; role = $u.Role; departmentId = $depId } -Token $token
    if ($newUser.Status -eq 201) {
        Write-Host "Usuario $($u.Email) creado ($($u.Role), $($u.DepartmentLabel))." -ForegroundColor Green
        $summary += [pscustomobject]@{ Usuario = $u.Name; Correo = $u.Email; Resultado = "Creado" }
    } else {
        $reason = if ($newUser.Body.error.message) { $newUser.Body.error.message } else { "código $($newUser.Status)" }
        Write-Host "No pude crear $($u.Email): $reason" -ForegroundColor Red
        $summary += [pscustomobject]@{ Usuario = $u.Name; Correo = $u.Email; Resultado = "Error: $reason" }
    }
}

Write-Host ""
Write-Host "Resumen" -ForegroundColor Cyan
$summary | Format-Table -AutoSize
Write-Host "Listo. Todas las cuentas usan la contraseña '$Password'." -ForegroundColor Green
Write-Host "Recuerda cambiar las contraseñas en cuanto el equipo empiece a usar la wiki." -ForegroundColor DarkGray
