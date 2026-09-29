#requires -Version 7
param(
    [string]$Tag,
    [string]$InputDirectory = (Join-Path $PSScriptRoot 'dist/js-checkin'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'artifacts/release')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

function Get-Sha256([string]$File) {
    return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Get-TextSha256([string]$Value) {
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()
}
function Test-Inside([string]$Parent, [string]$Child) {
    $relative = [IO.Path]::GetRelativePath($Parent, $Child)
    return $relative -eq '.' -or (
        -not [IO.Path]::IsPathRooted($relative) -and $relative -ne '..' -and
        -not $relative.StartsWith("..$([IO.Path]::DirectorySeparatorChar)")
    )
}

if ($Tag -and $Tag -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
    throw 'Tag 必须使用 v0.1.0 格式。'
}
$inputPath = [IO.Path]::GetFullPath($InputDirectory)
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
if ((Test-Inside $inputPath $outputPath) -or (Test-Inside $outputPath $inputPath)) {
    throw '发行输出目录与插件目录不能相互包含。'
}
if (-not (Test-Path -LiteralPath $inputPath -PathType Container)) {
    throw '未找到构建目录，请先执行 npm run build。'
}
$root = Get-Item -LiteralPath $inputPath -Force
if ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw '插件目录不能是符号链接。'
}

$expectedFiles = @('plugin.json', 'server/plugin.mjs', 'ui/index.html')
$files = @{}
$directories = @('server', 'ui')
foreach ($item in Get-ChildItem -LiteralPath $inputPath -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw '插件目录中存在符号链接。'
    }
    $relative = [IO.Path]::GetRelativePath($inputPath, $item.FullName).Replace('\', '/')
    if ($item.PSIsContainer) {
        if ($directories -cnotcontains $relative) { throw "插件目录存在额外目录：$relative" }
    } else {
        if ($expectedFiles -cnotcontains $relative) { throw "插件目录存在额外文件：$relative" }
        $files[$relative] = $item
    }
}
if ($files.Count -ne $expectedFiles.Count) { throw '构建产物不完整。' }
if ($files['plugin.json'].Length -gt 65536 -or
    $files['server/plugin.mjs'].Length -gt 2097152 -or
    $files['ui/index.html'].Length -gt 1048576) { throw '构建产物超过大小限制。' }

$manifest = Get-Content -LiteralPath $files['plugin.json'].FullName -Raw | ConvertFrom-Json -AsHashtable
if ($manifest.id -cne 'js-checkin' -or $root.Name -cne $manifest.id) {
    throw '插件 ID 与 js-checkin 目录不一致。'
}
if ($manifest.runtime -cne 'jint' -or $manifest.entry -cne 'server/plugin.mjs' -or
    $manifest.format -cne 'esm-bundle' -or $manifest.hostApi -cne '1' -or
    $manifest.page.entry -cne 'ui/index.html') { throw '构建清单格式不正确。' }
if ($manifest.version -isnot [string] -or $manifest.version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or
    $manifest.name -isnot [string] -or [string]::IsNullOrWhiteSpace($manifest.name) -or
    $manifest.description -isnot [string] -or [string]::IsNullOrWhiteSpace($manifest.description)) {
    throw '插件清单缺少有效版本、名称或描述。'
}
if (-not $Tag) { $Tag = "v$($manifest.version)" }

if (Test-Path -LiteralPath $outputPath) {
    $existing = Get-Item -LiteralPath $outputPath -Force
    if (-not $existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw '发行输出必须是普通目录。'
    }
    if (@(Get-ChildItem -LiteralPath $outputPath -Force).Count -ne 0) {
        throw "Release 输出目录不为空：$outputPath"
    }
}

$fileHashes = @{}
$content = @($expectedFiles | ForEach-Object {
    $fileHashes[$_] = Get-Sha256 $files[$_].FullName
    "$_ $($fileHashes[$_])"
}) -join "`n"
$contentHash = Get-TextSha256 $content
$asset = 'js-checkin.zip'
$archive = Join-Path $outputPath $asset
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
Compress-Archive -LiteralPath $inputPath -DestinationPath $archive

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    $seen = @{}
    foreach ($entry in $zip.Entries) {
        if (-not $entry.Name) { continue }
        $name = $entry.FullName.Replace('\', '/')
        if (-not $name.StartsWith('js-checkin/', [StringComparison]::Ordinal)) {
            throw 'ZIP 顶层目录不正确。'
        }
        $relative = $name.Substring('js-checkin/'.Length)
        if ($expectedFiles -cnotcontains $relative -or $seen.ContainsKey($relative)) {
            throw 'ZIP 包含额外或重复文件。'
        }
        $stream = $entry.Open()
        try {
            $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
        } finally { $stream.Dispose() }
        if ($hash -cne $fileHashes[$relative]) { throw 'ZIP 文件内容校验失败。' }
        $seen[$relative] = $true
    }
    if ($seen.Count -ne $expectedFiles.Count) { throw 'ZIP 文件不完整。' }
} finally { $zip.Dispose() }

$entry = [ordered]@{
    id = $manifest.id
    name = $manifest.name.Trim()
    description = $manifest.description.Trim()
    runtime = 'jint'
    version = $manifest.version
    asset = $asset
    sha256 = Get-Sha256 $archive
    contentSha256 = $contentHash
    sizeBytes = (Get-Item -LiteralPath $archive).Length
}
$index = [ordered]@{ schemaVersion = 1; tag = $Tag; plugins = @($entry) }
$index | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath (Join-Path $outputPath 'release-index.json') -Encoding utf8NoBOM
"$($entry.sha256)  $asset" |
    Set-Content -LiteralPath (Join-Path $outputPath "$asset.sha256") -Encoding ascii
$notes = @(
    "# $($entry.id)", '', $entry.description, '',
    "版本：$($entry.version)", "下载：$asset"
) -join "`n"
$customNotes = Join-Path $PSScriptRoot "release-notes/$Tag.md"
if (Test-Path -LiteralPath $customNotes -PathType Leaf) {
    $notes += "`n`n" + (Get-Content -LiteralPath $customNotes -Raw)
}
$notes | Set-Content -LiteralPath (Join-Path $outputPath 'release-notes.md') -Encoding utf8NoBOM
Write-Output $outputPath
