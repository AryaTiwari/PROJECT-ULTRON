# Simple Windows smoke test: validates that System.Speech can initialize the default microphone.
Add-Type -AssemblyName System.Speech
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$r.SetInputToDefaultAudioDevice()
$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
Write-Output 'WINDOWS_SPEECH_READY'
