$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$voiceEngine = $null
$voiceStream = $null
try {
    Add-Type -AssemblyName System.Speech
    $voiceRecognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
    if ($env:PIVOT_SERVER_SPEECH_MODE -eq 'probe') {
        @{ languages = @($voiceRecognizers | ForEach-Object { $_.Culture.Name }) } | ConvertTo-Json -Compress
        exit 0
    }
    $voicePayload = [Console]::In.ReadLine() | ConvertFrom-Json
    $voiceRecognizer = $voiceRecognizers | Where-Object { $_.Culture.Name -eq $voicePayload.language } | Select-Object -First 1
    if (-not $voiceRecognizer) { throw 'language-unavailable' }
    $voiceBytes = [Convert]::FromBase64String($voicePayload.audioBase64)
    $voicePayload = $null
    $voiceStream = New-Object System.IO.MemoryStream(,$voiceBytes)
    $voiceEngine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($voiceRecognizer)
    $voiceEngine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $voiceEngine.SetInputToWaveStream($voiceStream)
    $voiceText = New-Object System.Collections.Generic.List[string]
    while ($true) {
        try { $voiceResult = $voiceEngine.Recognize([TimeSpan]::FromSeconds(22)) }
        catch {
            if ($voiceText.Count -gt 0 -and $voiceStream.Position -ge $voiceStream.Length) { break }
            throw
        }
        if (-not $voiceResult) { break }
        if ($voiceResult.Text) { $voiceText.Add($voiceResult.Text) }
    }
    @{ text = ($voiceText -join ' '); language = $voiceRecognizer.Culture.Name } | ConvertTo-Json -Compress
} catch {
    @{ error = 'local-recognition-failed' } | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($voiceEngine) { $voiceEngine.Dispose() }
    if ($voiceStream) { $voiceStream.Dispose() }
    if ($voiceBytes) { [Array]::Clear($voiceBytes, 0, $voiceBytes.Length) }
}
