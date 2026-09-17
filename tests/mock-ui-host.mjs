import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const settings = await readFile(join(root, "plugins/deepseek-subagent/assets/settings.html"), "utf8");
const host = `<!doctype html><meta charset="utf-8"><title>MCP Apps mock host</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style><iframe src="/settings"></iframe><script>
let revision=4, model="mock-model-a",credentials=[{id:"key_aaaaaaaaaaaaaaaaaaaaaaaa",label:"Primary",baseUrl:"https://api.deepseek.com/v1/",enabled:true}];
const models=[{id:"mock-model-a"},{id:"mock-model-b"}];
const snapshot=()=>({schemaVersion:4,revision,model,baseUrl:credentials.find(c=>c.enabled)?.baseUrl||credentials[0]?.baseUrl||"https://api.deepseek.com/v1/",credentials:credentials.map((c,i)=>({...c,priority:i+1,status:c.enabled?"ready":"disabled"})),enabledCredentialCount:credentials.filter(c=>c.enabled).length,credentialConfigured:credentials.length>0,credentialMask:credentials.length?"••••••••":"",nativeReady:credentials.some(c=>c.enabled)&&!!model,message:"ok"});
addEventListener("message",(event)=>{const m=event.data;if(!m||m.jsonrpc!=="2.0")return;
if(m.method==="ui/initialize"){event.source.postMessage({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2099-12-31",hostContext:{locale:new URLSearchParams(location.search).get("locale")||"en-US",theme:"light"}}},"*");return;}
if(m.method==="tools/call"){const n=m.params.name,a=m.params.arguments||{};let data;
if(n==="deepseek_settings")data=snapshot();
if(n==="deepseek_models_list")data={models,selectedModel:model,message:"ok"};
if(n==="deepseek_settings_save"){model=a.model;revision++;data=snapshot();}
if(n==="deepseek_credential_add"){credentials.push({id:"key_"+("b".repeat(23)+credentials.length),label:a.label,baseUrl:a.baseUrl,enabled:true});model="";revision++;data=snapshot();}
if(n==="deepseek_credential_update"){credentials=credentials.map(c=>c.id===a.id?{...c,label:a.label,baseUrl:a.baseUrl,enabled:a.enabled}:c);revision++;data=snapshot();}
if(n==="deepseek_credential_move"){const i=credentials.findIndex(c=>c.id===a.id),j=a.direction==="up"?i-1:i+1;[credentials[i],credentials[j]]=[credentials[j],credentials[i]];revision++;data=snapshot();}
if(n==="deepseek_credential_remove"){credentials=credentials.filter(c=>c.id!==a.id);if(!credentials.length)model="";revision++;data=snapshot();}
if(n==="deepseek_credential_delete"){credentials=[];model="";revision++;data=snapshot();}
if(n==="deepseek_connection_test")data=snapshot();
event.source.postMessage({jsonrpc:"2.0",id:m.id,result:{structuredContent:data,content:[{type:"text",text:"ok"}]}},"*");}}
);</script>`;
const server=createServer((req,res)=>{res.setHeader("content-type","text/html; charset=utf-8");res.end(req.url.startsWith("/settings")?settings:host);});
server.listen(Number(process.env.PORT||4173),"127.0.0.1",()=>process.stdout.write(`http://127.0.0.1:${process.env.PORT||4173}\n`));
