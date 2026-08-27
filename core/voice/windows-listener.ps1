$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $recognizer.SetInputToDefaultAudioDevice()
  $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(15)
  $recognizer.BabbleTimeout = [TimeSpan]::FromSeconds(5)
  $culture = [System.Globalization.CultureInfo]::InstalledUICulture
  $grammar = New-Object System.Speech.Recognition.DictationGrammar
  $recognizer.LoadGrammar($grammar)

  @{ type = 'listener_started'; platform = 'windows'; culture = $culture.Name; wake_word = 'ULTRON' } | ConvertTo-Json -Compress
  [Console]::Out.Flush()

  $recognizer.add_SpeechHypothesized({
    param($sender, $e)
    if ($e.Result.Text) {
      @{ type = 'hypothesis'; text = [string]$e.Result.Text } | ConvertTo-Json -Compress
      [Console]::Out.Flush()
    }
  })

  $recognizer.add_SpeechRecognized({
    param($sender, $e)
    $text = [string]$e.Result.Text
    if ($text) {
      @{ type = 'transcript'; text = $text; confidence = [double]$e.Result.Confidence } | ConvertTo-Json -Compress
      [Console]::Out.Flush()
    }
  })

  $recognizer.add_RecognizeCompleted({
    param($sender, $e)
    if ($e.Error) {
      @{ type = 'error'; error = $e.Error.Message } | ConvertTo-Json -Compress
      [Console]::Out.Flush()
    } elseif ($e.Cancelled) {
      @{ type = 'error'; error = 'Speech recognition cancelled.' } | ConvertTo-Json -Compress
      [Console]::Out.Flush()
    }
  })

  $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  while ($true) { Start-Sleep -Seconds 1 }
} catch {
  @{ type = 'error'; error = $_.Exception.Message; detail = $_.Exception.ToString() } | ConvertTo-Json -Compress
  [Console]::Out.Flush()
  exit 1
}
