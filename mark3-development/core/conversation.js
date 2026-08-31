const config=require('./config');const {appendJsonl,readJsonl}=require('./persistence');
function append(role,content,meta={}){appendJsonl(config.conversationPath,{id:`msg-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,role,content:String(content||''),...meta,at:new Date().toISOString()});}
function recent(limit=config.maxConversationItems){return readJsonl(config.conversationPath).slice(-limit).map(m=>({role:m.role,content:m.content,at:m.at,model:m.model||null}));}
module.exports={append,recent};
