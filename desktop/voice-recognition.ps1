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
    # 保留自然短停顿，避免使用 150/500ms 默认值把中文长句切得过碎。
    $voiceEngine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(850)
    $voiceEngine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(1200)
    try { $voiceEngine.SetInputToDefaultAudioDevice() }
    catch {
        Send-VoiceEvent @{ type = 'error'; code = 'audio-capture' }
        exit 1
    }
    # 收尾时让引擎处理已采集的尾句；退出和取消仍由主进程立即回收。
    Register-ObjectEvent -InputObject $voiceEngine -EventName SpeechRecognized -SourceIdentifier 'pivot-voice-result' | Out-Null
    Register-ObjectEvent -InputObject $voiceEngine -EventName RecognizeCompleted -SourceIdentifier 'pivot-voice-ended' | Out-Null
    $voiceEngine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
    Send-VoiceEvent @{ type = 'started'; language = $voiceRecognizer.Culture.Name }
    # Console.In 的同步包装可能阻塞 ReadLineAsync，单独的流读取器才能并行等待收尾指令。
    $voiceCommandReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
    $voiceCommand = $voiceCommandReader.ReadLineAsync()
    $voiceFinishing = $false
    $voiceComplete = $false
    while (-not $voiceComplete) {
        if (-not $voiceFinishing -and $voiceCommand.IsCompleted) {
            $voiceInstruction = $voiceCommand.Result
            if ($voiceInstruction -eq 'finish' -or $null -eq $voiceInstruction) {
                $voiceFinishing = $true
                $voiceEngine.RecognizeAsyncStop()
            } else { $voiceCommand = $voiceCommandReader.ReadLineAsync() }
        }
        foreach ($voiceEvent in @(Get-Event)) {
            if ($voiceEvent.SourceIdentifier -eq 'pivot-voice-result') {
                $voiceResult = $voiceEvent.SourceEventArgs.Result
                if ($voiceResult -and $voiceResult.Text) { Send-VoiceEvent @{ type = 'result'; text = $voiceResult.Text } }
            }
            if ($voiceEvent.SourceIdentifier -eq 'pivot-voice-ended') {
                if ($voiceEvent.SourceEventArgs.Error) { throw 'native-recognition-unavailable' }
                $voiceComplete = $true
            }
            Remove-Event -EventIdentifier $voiceEvent.EventIdentifier
        }
        if (-not $voiceComplete) { Start-Sleep -Milliseconds 25 }
    }
    Send-VoiceEvent @{ type = 'ended' }
} catch {
    Send-VoiceEvent @{ type = 'error'; code = 'native-recognition-unavailable' }
    exit 1
} finally {
    Unregister-Event -SourceIdentifier 'pivot-voice-result' -ErrorAction SilentlyContinue
    Unregister-Event -SourceIdentifier 'pivot-voice-ended' -ErrorAction SilentlyContinue
    if ($voiceEngine) { $voiceEngine.Dispose() }
}
