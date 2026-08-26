Add-Type -AssemblyName System.Speech
$recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$recognizer.SetInputToDefaultAudioDevice()
$grammar = New-Object System.Speech.Recognition.DictationGrammar
$recognizer.LoadGrammar($grammar)
$recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
$recognizer.add_SpeechRecognized({
  param($sender, $e)
  $text = [string]$e.Result.Text
  if ($text) {
    $payload = @{ type = 'transcript'; text = $text; confidence = [double]$e.Result.Confidence }
    $payload | ConvertTo-Json -Compress
  }
})
$recognizer.add_RecognizeCompleted({
  param($sender, $e)
  if ($e.Error) { @{ type = 'error'; error = $e.Error.Message } | ConvertTo-Json -Compress }
})
while ($true) { Start-Sleep -Seconds 1 }
