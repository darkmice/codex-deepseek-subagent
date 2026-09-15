import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const settings = await readFile(join(root, "plugins/deepseek-subagent/assets/settings.html"), "utf8");
const host = `<!doctype html><meta charset="utf-8"><title>MCP Apps mock host</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style><iframe src="/settings"></iframe><script>
let revision=4, configured=true, model="mock-model-a";
const models=[{id:"mock-model-a"},{id:"mock-model-b"}];
addEventListener("message",(event)=>{const m=event.data;if(!m||m.jsonrpc!=="2.0")return;
if(m.method==="ui/initialize"){event.source.postMessage({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2099-12-31",hostContext:{locale:new URLSearchParams(location.search).get("locale")||"en-US",theme:"light"}}},"*");return;}
if(m.method==="tools/call"){const n=m.params.name,a=m.params.arguments||{};let data;
if(n==="deepseek_settings")data={schemaVersion:2,revision,model,credentialConfigured:configured,credentialMask:configured?"••••••••":"",nativeReady:configured&&!!model,message:"ok"};
if(n==="deepseek_models_list")data={models,selectedModel:model,message:"ok"};
if(n==="deepseek_settings_save"){model=a.model;revision++;data={schemaVersion:2,revision,model,credentialConfigured:configured,credentialMask:"••••••••",nativeReady:true,message:"ok"};}
if(n==="deepseek_credential_set"){configured=true;revision++;data={schemaVersion:2,revision,model,credentialConfigured:true,credentialMask:"••••••••",nativeReady:!!model,message:"ok"};}
if(n==="deepseek_credential_delete"){configured=false;model="";revision++;data={schemaVersion:2,revision,model,credentialConfigured:false,credentialMask:"",nativeReady:false,message:"ok"};}
if(n==="deepseek_connection_test")data={schemaVersion:2,revision,model,credentialConfigured:configured,credentialMask:configured?"••••••••":"",nativeReady:configured&&!!model,message:"ok"};
event.source.postMessage({jsonrpc:"2.0",id:m.id,result:{structuredContent:data,content:[{type:"text",text:"ok"}]}},"*");}}
);</script>`;
const server=createServer((req,res)=>{res.setHeader("content-type","text/html; charset=utf-8");res.end(req.url.startsWith("/settings")?settings:host);});
server.listen(Number(process.env.PORT||4173),"127.0.0.1",()=>process.stdout.write(`http://127.0.0.1:${process.env.PORT||4173}\n`));
