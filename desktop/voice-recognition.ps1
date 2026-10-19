$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Send-VoiceEvent($payload) {
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
}

$voiceEngine = $null
try {
    Add-Type -AssemblyName System.Speech
    $voiceRecognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
    $voiceLanguage = $env:PIVOT_NATIVE_VOICE_LANGUAGE
    $voiceRecognizer = $voiceRecognizers | Where-Object { $_.Culture.Name -eq $voiceLanguage } | Select-Object -First 1
    if ($env:PIVOT_NATIVE_VOICE_MODE -eq 'probe') {
        Send-VoiceEvent @{ type = 'capabilities'; languages = @($voiceRecognizers | ForEach-Object { $_.Culture.Name }) }
        exit 0
    }
    if (-not $voiceRecognizer) {
        Send-VoiceEvent @{ type = 'error'; code = 'language-not-supported' }
        exit 1
    }
    $voiceEngine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($voiceRecognizer)
    $voiceEngine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    try { $voiceEngine.SetInputToDefaultAudioDevice() }
    catch {
        Send-VoiceEvent @{ type = 'error'; code = 'audio-capture' }
        exit 1
    }
    Send-VoiceEvent @{ type = 'started'; language = $voiceRecognizer.Culture.Name }
    # 同步识别运行于专用隐藏进程；停止时主进程回收整个工作进程及音频句柄。
    while ($true) {
        $voiceResult = $voiceEngine.Recognize([TimeSpan]::FromSeconds(8))
        if ($voiceResult -and $voiceResult.Text) {
            Send-VoiceEvent @{ type = 'result'; text = $voiceResult.Text }
        }
    }
} catch {
    Send-VoiceEvent @{ type = 'error'; code = 'native-recognition-unavailable' }
    exit 1
} finally {
    if ($voiceEngine) { $voiceEngine.Dispose() }
}
