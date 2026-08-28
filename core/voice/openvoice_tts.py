import argparse
import os
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--text', required=True)
    parser.add_argument('--reference', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--language', default='en')
    args = parser.parse_args()

    try:
        import torch
        from openvoice import se_extractor
        from openvoice.api import ToneColorConverter
        from melo.api import TTS
    except Exception as exc:
        print(f'OpenVoice dependencies are not installed: {exc}', file=sys.stderr)
        return 2

    root = Path(os.environ.get('ULTRON_OPENVOICE_ROOT', Path.cwd() / '.ultron' / 'voice' / 'openvoice'))
    ckpt_dir = root / 'checkpoints_v2'
    converter_dir = ckpt_dir / 'converter'
    base_dir = ckpt_dir / 'base_speakers' / 'ses'
    cache_dir = root / 'processed'
    cache_dir.mkdir(parents=True, exist_ok=True)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)

    device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
    converter = ToneColorConverter(str(converter_dir / 'config.json'), device=device)
    converter.load_ckpt(str(converter_dir / 'checkpoint.pth'))

    ref_path = str(Path(args.reference).resolve())
    target_se, _ = se_extractor.get_se(ref_path, converter, target_dir=str(cache_dir), vad=True)

    lang = args.language.upper()
    if lang == 'EN':
        lang = 'EN'
    tts = TTS(language=lang, device=device)
    speakers = tts.hps.data.spk2id
    preferred = ['EN-Default', 'EN-US', 'EN-Default'] if lang == 'EN' else list(speakers.keys())
    base_key = next((key for key in preferred if key in speakers), next(iter(speakers)))
    source_se_name = base_key.lower()
    source_se_path = base_dir / f'{source_se_name}.pth'
    if not source_se_path.exists() and source_se_name == 'en-default':
        source_se_path = base_dir / 'en-default.pth'
    if not source_se_path.exists():
        raise FileNotFoundError(f'OpenVoice source speaker embedding not found: {source_se_path}')
    source_se = torch.load(source_se_path, map_location=device)

    tmp_path = root / 'base_tts.wav'
    tts.tts_to_file(args.text, speakers[base_key], str(tmp_path), speed=1.0)
    converter.convert(audio_src_path=str(tmp_path), src_se=source_se, tgt_se=target_se, output_path=args.output, message='@ULTRON')
    print(__import__('json').dumps({'ok': True, 'path': str(Path(args.output).resolve()), 'device': device, 'baseSpeaker': base_key}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
