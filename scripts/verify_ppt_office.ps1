param(
    [Parameter(Mandatory = $true)][string]$PresentationPath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$presentationFile = (Resolve-Path -LiteralPath $PresentationPath).Path
$inputDigest = (Get-FileHash -LiteralPath $presentationFile -Algorithm SHA256).Hash.ToLowerInvariant()
$resultDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
$existingPowerPoint = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$powerPoint = $null
$presentation = $null
$nativeRecords = [System.Collections.Generic.List[object]]::new()
$textRecords = [System.Collections.Generic.List[object]]::new()
function Read-PresentationShape($shape, [int]$slideIndex, [string]$groupName = '') {
    $record = [ordered]@{ slide = $slideIndex; name = $shape.Name; id = [int]$shape.Id; type = [int]$shape.Type; group = $groupName }
    if ($shape.Type -eq 1) { $record.autoShapeType = [int]$shape.AutoShapeType; $record.adjustments = [int]$shape.Adjustments.Count }
    if ($shape.Connector -eq -1) {
        $record.beginConnected = $shape.ConnectorFormat.BeginConnected -eq -1
        $record.endConnected = $shape.ConnectorFormat.EndConnected -eq -1
        if ($record.beginConnected) { $record.from = $shape.ConnectorFormat.BeginConnectedShape.Name }
        if ($record.endConnected) { $record.to = $shape.ConnectorFormat.EndConnectedShape.Name }
    }
    $nativeRecords.Add([pscustomobject]$record)
    if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) {
        $frame = $shape.TextFrame2
        $textRecords.Add([pscustomobject]@{
            slide = $slideIndex; name = $shape.Name; text = $shape.TextFrame.TextRange.Text
            x = [double]$shape.Left; y = [double]$shape.Top; width = [double]$shape.Width; height = [double]$shape.Height
            boundWidth = [double]$frame.TextRange.BoundWidth; boundHeight = [double]$frame.TextRange.BoundHeight
            overflow = ($frame.TextRange.BoundWidth -gt $shape.Width + 2 -or $frame.TextRange.BoundHeight -gt $shape.Height + 2)
        })
    }
    if ($shape.Type -eq 6) { foreach ($child in $shape.GroupItems) { Read-PresentationShape $child $slideIndex $shape.Name } }
}
try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    $powerPoint.DisplayAlerts = 1
    $presentation = $powerPoint.Presentations.Open($presentationFile, -1, 0, 0)
    foreach ($slide in $presentation.Slides) {
        $slide.Export((Join-Path $resultDirectory ("slide-{0}.png" -f $slide.SlideIndex)), 'PNG', 1280, 720)
        foreach ($shape in $slide.Shapes) {
            Read-PresentationShape $shape $slide.SlideIndex
        }
    }
    $presentation.SaveAs((Join-Path $resultDirectory 'PowerPoint实际渲染.pdf'), 32)
    $textRecords.ToArray() | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $resultDirectory '文字边界核验.json') -Encoding utf8
    $nativeRecords.ToArray() | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $resultDirectory '原生对象核验.json') -Encoding utf8
    if ((Get-FileHash -LiteralPath $presentationFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $inputDigest) { throw '核验期间原始PPTX已变化，请重新执行。' }
    [pscustomobject]@{ engine = 'Microsoft PowerPoint'; engineVersion = $powerPoint.Version; outputDigest = $inputDigest; checkedAt = [DateTime]::UtcNow.ToString('o'); slides = $presentation.Slides.Count; nativeObjects = $nativeRecords.Count } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $resultDirectory 'office-manifest.json') -Encoding utf8
    Write-Output ("已用 PowerPoint 渲染 {0} 页；回读 {1} 个原生对象；发现 {2} 个文字边界问题。" -f $presentation.Slides.Count, $nativeRecords.Count, @($textRecords | Where-Object overflow).Count)
} finally {
    if ($presentation) { $presentation.Close(); [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) | Out-Null }
    if ($powerPoint) {
        if (-not $existingPowerPoint) { $powerPoint.Quit() }
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint) | Out-Null
    }
}
