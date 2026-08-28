import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--text', required=True)
    parser.add_argument('--reference', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--language', default='en')
    parser.add_argument('--model', default='ResembleAI/chatterbox-turbo')
    parser.add_argument('--exaggeration', type=float, default=0.45)
    parser.add_argument('--cfg-weight', type=float, default=0.5)
    args = parser.parse_args()

    if args.language.lower() not in ('en', 'en-us', 'english'):
        raise RuntimeError('Chatterbox Turbo integration currently targets English output.')

    from chatterbox.tts_turbo import ChatterboxTurboTTS
    import torchaudio as ta

    reference = Path(args.reference).resolve()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if not reference.exists():
        raise FileNotFoundError(f'Reference audio not found: {reference}')

    model = ChatterboxTurboTTS.from_pretrained(device='cpu')
    wav = model.generate(
        args.text,
        audio_prompt_path=str(reference),
        exaggeration=args.exaggeration,
        cfg_weight=args.cfg_weight,
    )
    ta.save(str(output), wav, model.sr)
    print(json.dumps({'ok': True, 'path': str(output), 'model': args.model, 'reference': str(reference)}))


if __name__ == '__main__':
    main()
