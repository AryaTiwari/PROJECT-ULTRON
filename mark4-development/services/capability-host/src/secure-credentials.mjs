import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const mark4Root=path.resolve(new URL("../../..",import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/,m=>m.slice(1)));
const directory=path.join(mark4Root,".runtime","credentials"),safe=id=>String(id).replace(/[^a-z0-9-]/gi,"_"),fileFor=id=>path.join(directory,safe(id)+".dpapi");
function ps(script,input=""){return execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{encoding:"utf8",windowsHide:true,input}).trim();}
export function managedCredentialPresent(id){return fs.existsSync(fileFor(id));}
export function storeCredential(id,value){const secret=String(value||"").trim();if(!secret)throw new Error("INTEGRATION_SECRET_REQUIRED");if(process.platform!=="win32")throw new Error("SECURE_CREDENTIAL_STORE_UNAVAILABLE");fs.mkdirSync(directory,{recursive:true});const script='Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($p)';const protectedValue=ps(script,secret);if(!protectedValue)throw new Error("SECURE_CREDENTIAL_ENCRYPTION_FAILED");fs.writeFileSync(fileFor(id),protectedValue,{encoding:"utf8",mode:0o600});return true;}
export function readCredential(id){const file=fileFor(id);if(!fs.existsSync(file)||process.platform!=="win32")return null;const blob=fs.readFileSync(file,"utf8").trim(),script='Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$p=[Convert]::FromBase64String($v);$b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Text.Encoding]::UTF8.GetString($b)';return ps(script,blob);}
export function deleteCredential(id){const file=fileFor(id);if(fs.existsSync(file))fs.unlinkSync(file);return true;}
