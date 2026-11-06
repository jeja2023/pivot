param(
    [Parameter(Mandatory = $true)][string]$PresentationPath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$presentationFile = (Resolve-Path -LiteralPath $PresentationPath).Path
$resultDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
$existingPowerPoint = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$powerPoint = $null
$presentation = $null
try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    $powerPoint.DisplayAlerts = 1
    $presentation = $powerPoint.Presentations.Open($presentationFile, -1, 0, 0)
    $report = @()
    foreach ($slide in $presentation.Slides) {
        $slide.Export((Join-Path $resultDirectory ("slide-{0}.png" -f $slide.SlideIndex)), 'PNG', 1280, 720)
        foreach ($shape in $slide.Shapes) {
            if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) {
                $frame = $shape.TextFrame2
                $report += [pscustomobject]@{
                    slide = $slide.SlideIndex
                    name = $shape.Name
                    text = $shape.TextFrame.TextRange.Text
                    x = [double]$shape.Left
                    y = [double]$shape.Top
                    width = [double]$shape.Width
                    height = [double]$shape.Height
                    boundWidth = [double]$frame.TextRange.BoundWidth
                    boundHeight = [double]$frame.TextRange.BoundHeight
                    overflow = ($frame.TextRange.BoundWidth -gt $shape.Width + 2 -or $frame.TextRange.BoundHeight -gt $shape.Height + 2)
                }
            }
        }
    }
    $presentation.SaveAs((Join-Path $resultDirectory 'PowerPoint实际渲染.pdf'), 32)
    $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $resultDirectory '文字边界核验.json') -Encoding utf8
    Write-Output ("已用 PowerPoint 渲染 {0} 页；发现 {1} 个文字边界问题。" -f $presentation.Slides.Count, @($report | Where-Object overflow).Count)
} finally {
    if ($presentation) { $presentation.Close(); [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) | Out-Null }
    if ($powerPoint) {
        if (-not $existingPowerPoint) { $powerPoint.Quit() }
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint) | Out-Null
    }
}
