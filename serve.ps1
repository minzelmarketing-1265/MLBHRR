$ErrorActionPreference = "Continue"
$port = 8778
$root = $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$port/"
while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.LocalPath.TrimStart('/')
    if ([string]::IsNullOrEmpty($path)) { $path = "index.html" }
    $file = Join-Path $root $path
    if (Test-Path $file -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      if ($file -match '\.html$')      { $ctx.Response.ContentType = "text/html; charset=utf-8" }
      elseif ($file -match '\.js$')    { $ctx.Response.ContentType = "application/javascript; charset=utf-8" }
      elseif ($file -match '\.css$')   { $ctx.Response.ContentType = "text/css; charset=utf-8" }
      $ctx.Response.ContentLength64 = $bytes.Length
      if ($ctx.Request.HttpMethod -ne "HEAD") {
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    } else {
      $ctx.Response.StatusCode = 404
    }
    try { $ctx.Response.Close() } catch {}
  } catch {
    Write-Host "Request error: $($_.Exception.Message)"
  }
}
