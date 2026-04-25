# One-shot Postgres password reset for local dev.
# Run from an Administrator PowerShell window (right-click → Run as administrator).
#
# What it does:
#   1. Stops the postgresql-x64-16 service.
#   2. Backs up pg_hba.conf and switches local IPv4/IPv6 auth to "trust".
#   3. Starts the service.
#   4. Resets the postgres user's password to "proof123" and creates the
#      iproofnow + iproofnow_test databases.
#   5. Restores pg_hba.conf from the backup (back to scram-sha-256).
#   6. Restarts the service.
#
# Idempotent: re-running won't double-create databases (uses IF NOT EXISTS pattern).

$ErrorActionPreference = 'Stop'

$serviceName = 'postgresql-x64-16'
$dataDir = 'C:\Program Files\PostgreSQL\16\data'
$hba = Join-Path $dataDir 'pg_hba.conf'
$backup = "$hba.bak-$(Get-Date -Format yyyyMMddHHmmss)"

if (-not (Test-Path $hba)) {
    Write-Error "pg_hba.conf not found at $hba. Edit `$dataDir at the top of this script if your Postgres install is elsewhere."
}

Write-Host "[1/6] Stopping $serviceName..."
Stop-Service $serviceName

Write-Host "[2/6] Backing up pg_hba.conf to $backup"
Copy-Item $hba $backup

Write-Host "      Switching local auth to trust (temporary)..."
$content = Get-Content $hba -Raw
$patched = $content `
    -replace '(?m)^(host\s+all\s+all\s+127\.0\.0\.1/32\s+)scram-sha-256', '$1trust' `
    -replace '(?m)^(host\s+all\s+all\s+::1/128\s+)scram-sha-256', '$1trust'
Set-Content -Path $hba -Value $patched -Encoding ascii

Write-Host "[3/6] Starting $serviceName..."
Start-Service $serviceName
Start-Sleep -Seconds 2

Write-Host "[4/6] Resetting postgres password and creating databases..."
& psql -U postgres -d postgres -c "ALTER USER postgres PASSWORD 'proof123';"
& psql -U postgres -d postgres -c "SELECT 'CREATE DATABASE iproofnow' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'iproofnow')\gexec"
& psql -U postgres -d postgres -c "SELECT 'CREATE DATABASE iproofnow_test' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'iproofnow_test')\gexec"

Write-Host "[5/6] Restoring pg_hba.conf from backup..."
Copy-Item $backup $hba -Force

Write-Host "[6/6] Restarting $serviceName..."
Restart-Service $serviceName

Write-Host ""
Write-Host "Done. postgres user now has password 'proof123', databases iproofnow + iproofnow_test exist."
Write-Host "You can close this admin window and continue in a regular PowerShell."
Write-Host ""
Write-Host "Press Enter to close..."
[void][System.Console]::ReadLine()
