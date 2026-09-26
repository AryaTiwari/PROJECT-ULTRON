import json
import os
import pathlib
import sys


def fail(message):
    print(json.dumps({"error": str(message)}))
    return 1


def main():
    if len(sys.argv) < 2:
        return fail("SPREADSHEET_ID_REQUIRED")
    root = pathlib.Path(__file__).resolve().parents[1]
    hermes_home = pathlib.Path(os.environ.get("HERMES_HOME", root / ".runtime" / "hermes-home"))
    profile_scripts = hermes_home / "skills" / "productivity" / "google-workspace" / "scripts"
    bundled_scripts = root / ".runtime" / "vendor" / "hermes-agent" / "skills" / "productivity" / "google-workspace" / "scripts"
    scripts = profile_scripts if (profile_scripts / "google_api.py").exists() else bundled_scripts
    sys.path.insert(0, str(scripts))
    try:
        import google_api
        service = google_api.build_service("sheets", "v4")
        result = service.spreadsheets().get(
            spreadsheetId=sys.argv[1],
            fields="spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties))",
        ).execute()
        print(json.dumps(result))
        return 0
    except Exception as exc:
        return fail(exc)


if __name__ == "__main__":
    raise SystemExit(main())
