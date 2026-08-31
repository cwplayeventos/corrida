import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { MercadoPagoConfig, Order } from "mercadopago";
import { google } from "googleapis";

const app=express();
const PORT=process.env.PORT||3000;
const kits={
  basico:{name:"Corrida / Caminhada",price:19.90,shirt:false},
  medalha:{name:"Com Medalha",price:39.90,shirt:false},
  completo:{name:"Kit Completo",price:59.90,shirt:true}
};
const allowedOrigins=(process.env.FRONTEND_ORIGIN||"").split(",").map(x=>x.trim()).filter(Boolean);
app.use(cors({origin:(origin,cb)=>{if(!origin||allowedOrigins.length===0||allowedOrigins.includes(origin))return cb(null,true);cb(new Error("Origem não permitida."))}}));
app.use(express.json({limit:"1mb"}));

const mpClient=new MercadoPagoConfig({accessToken:process.env.MERCADOPAGO_ACCESS_TOKEN});
const orderClient=new Order(mpClient);

function brl(v){return Number(v).toFixed(2)}
function clean(v){return String(v??"").trim().replace(/[<>]/g,"")}
function registrationId(){return "GDB-"+Date.now().toString().slice(-8)+Math.floor(Math.random()*90+10)}
function totalOf(participants){return participants.reduce((sum,p)=>{const k=kits[p.kitId];if(!k)throw Error("Kit inválido.");if(!["2,5 km","5 km"].includes(p.distance))throw Error("Distância inválida.");if(!["Corrida","Caminhada"].includes(p.mode))throw Error("Modalidade inválida.");if(k.shirt&&!p.shirt)throw Error("Tamanho da camiseta obrigatório.");return sum+k.price},0)}

async function sheetsAuth(){
  const auth=new google.auth.JWT({email:process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,key:process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g,"\n"),scopes:["https://www.googleapis.com/auth/spreadsheets"]});
  return google.sheets({version:"v4",auth});
}
async function appendRegistration(reg,parts){
  if(!process.env.GOOGLE_SHEET_ID||!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL)return;
  const sheets=await sheetsAuth();
  const now=new Date().toISOString();
  await sheets.spreadsheets.values.append({spreadsheetId:process.env.GOOGLE_SHEET_ID,range:"Inscrições!A:J",valueInputOption:"USER_ENTERED",requestBody:{values:[[reg.id,now,reg.responsible.name,reg.responsible.whatsapp,parts.length,reg.total,"PENDENTE",reg.mpOrderId||"",reg.pixId||"",now]]}});
  await sheets.spreadsheets.values.append({spreadsheetId:process.env.GOOGLE_SHEET_ID,range:"Participantes!A:J",valueInputOption:"USER_ENTERED",requestBody:{values:parts.map((p,i)=>[`${reg.id}-${String(i+1).padStart(2,"0")}`,reg.id,p.name,p.whatsapp,p.mode,p.distance,kits[p.kitId].name,p.shirt||"",kits[p.kitId].price,"PENDENTE"])}})}
async function updateRegistrationPaid(regId,mpId,status){
  if(!process.env.GOOGLE_SHEET_ID||!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL)return;
  const sheets=await sheetsAuth();
  const res=await sheets.spreadsheets.values.get({spreadsheetId:process.env.GOOGLE_SHEET_ID,range:"Inscrições!A:J"});
  const rows=res.data.values||[];
  const idx=rows.findIndex((r,i)=>i>0&&String(r[0])===String(regId));
  if(idx<1)return;
  await sheets.spreadsheets.values.update({spreadsheetId:process.env.GOOGLE_SHEET_ID,range:`Inscrições!G${idx+1}:J${idx+1}`,valueInputOption:"USER_ENTERED",requestBody:{values:[[status,mpId||"",rows[idx][8]||"",new Date().toISOString()]]}});
  const pRes=await sheets.spreadsheets.values.get({spreadsheetId:process.env.GOOGLE_SHEET_ID,range:"Participantes!A:J"});
  const pRows=pRes.data.values||[];
  const changes=[];
  pRows.forEach((r,i)=>{if(i>0&&String(r[1])===String(regId))changes.push({row:i+1});});
  for(const c of changes)await sheets.spreadsheets.values.update({spreadsheetId:process.env.GOOGLE_SHEET_ID,range:`Participantes!J${c.row}`,valueInputOption:"USER_ENTERED",requestBody:{values:[[status]]}});
}

async function createMpOrder(regId,total,responsible){
  const expires=new Date(Date.now()+Number(process.env.PIX_EXPIRATION_MINUTES||30)*60000);
  const order=await orderClient.create({body:{
    type:"online",total_amount:brl(total),external_reference:regId,processing_mode:"automatic",
    transactions:{payments:[{amount:brl(total),payment_method:{id:"pix",type:"bank_transfer"},expiration_time:`PT${Number(process.env.PIX_EXPIRATION_MINUTES||30)}M`}]},
    payer:{email:responsible.email||"pagamento@cwplayeventos.com"}
  },requestOptions:{idempotencyKey:crypto.randomUUID()}});
  const payment=order?.transactions?.payments?.[0];
  const method=payment?.payment_method;
  if(!method?.qr_code||!method?.qr_code_base64)throw Error("Mercado Pago não retornou os dados do Pix.");
  return {orderId:order.id,paymentId:payment.id,pixCode:method.qr_code,qrCodeBase64:method.qr_code_base64,expiresAt:expires.toISOString()};
}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"guerreiros-baca",version:"2.0"}));

app.post("/api/registrations",async(req,res)=>{
 try{
  const {responsible,participants}=req.body||{};
  if(!responsible?.name||!responsible?.whatsapp)throw Error("Informe o responsável e o WhatsApp.");
  if(!Array.isArray(participants)||participants.length<1||participants.length>20)throw Error("Quantidade de participantes inválida.");
  const normalized=participants.map(p=>({name:clean(p.name),whatsapp:clean(p.whatsapp),mode:clean(p.mode),distance:clean(p.distance),kitId:clean(p.kitId),shirt:clean(p.shirt)}));
  if(normalized.some(p=>!p.name||!p.whatsapp||!p.mode||!p.distance||!p.kitId))throw Error("Preencha todos os dados dos participantes.");
  const total=totalOf(normalized),id=registrationId();
  const mp=await createMpOrder(id,total,{email:clean(responsible.email)});
  const reg={id,responsible:{name:clean(responsible.name),whatsapp:clean(responsible.whatsapp),email:clean(responsible.email)},total,mpOrderId:mp.orderId,pixId:mp.paymentId};
  await appendRegistration(reg,normalized);
  res.json({success:true,registrationId:id,total, ...mp});
 }catch(e){console.error(e);res.status(400).json({success:false,message:e.message||"Erro interno."})}
});

async function getOrder(id){return await orderClient.get({id})}
app.get("/api/registrations/:id/status",async(req,res)=>{
 try{
  // Consulta por external_reference para localizar a order.
  // Para reduzir dependência de busca, esta versão usa o ID da inscrição
  // armazenado na planilha e pode ser estendida com banco de dados.
  if(!process.env.GOOGLE_SHEET_ID)return res.json({status:"PENDENTE"});
  const sheets=await sheetsAuth();const data=await sheets.spreadsheets.values.get({spreadsheetId:process.env.GOOGLE_SHEET_ID,range:"Inscrições!A:J"});
  const row=(data.data.values||[]).find((r,i)=>i>0&&String(r[0])===String(req.params.id));
  if(!row)return res.status(404).json({message:"Inscrição não encontrada."});
  const mpId=row[7];
  if(!mpId)return res.json({status:row[6]||"PENDENTE"});
  const order=await getOrder(mpId);const status=order?.status;
  const paid=status==="processed"||status==="approved"||order?.transactions?.payments?.some(p=>p.status==="processed");
  if(paid&&row[6]!=="PAGO")await updateRegistrationPaid(req.params.id,mpId,"PAGO");
  return res.json({status:paid?"PAGO":(status||row[6]||"PENDENTE")});
 }catch(e){console.error(e);res.status(500).json({message:"Não foi possível consultar o pagamento."})}
});

app.post("/api/registrations/:id/pix",async(req,res)=>{
 try{
  if(!process.env.GOOGLE_SHEET_ID)throw Error("Google Sheets não configurado.");
  const sheets=await sheetsAuth();const data=await sheets.spreadsheets.values.get({spreadsheetId:process.env.GOOGLE_SHEET_ID,range:"Inscrições!A:J"});
  const row=(data.data.values||[]).find((r,i)=>i>0&&String(r[0])===String(req.params.id));
  if(!row)throw Error("Inscrição não encontrada.");
  if(row[6]==="PAGO")throw Error("Esta inscrição já está paga.");
  const mp=await createMpOrder(req.params.id,Number(row[5]),{email:"pagamento@cwplayeventos.com"});
  const idx=(data.data.values||[]).findIndex(r=>String(r[0])===String(req.params.id));
  await sheets.spreadsheets.values.update({spreadsheetId:process.env.GOOGLE_SHEET_ID,range:`Inscrições!H${idx+1}:I${idx+1}`,valueInputOption:"USER_ENTERED",requestBody:{values:[[mp.orderId,mp.paymentId]]}});
  res.json({success:true,registrationId:req.params.id,total:Number(row[5]),...mp});
 }catch(e){res.status(400).json({success:false,message:e.message})}
});

// Webhook recomendado pelo Mercado Pago para Orders.
// Configure uma URL HTTPS como /api/webhooks/mercadopago e selecione Order.
app.post("/api/webhooks/mercadopago",async(req,res)=>{
 try{
  // Validação HMAC do x-signature deve ser habilitada antes da produção.
  // O Mercado Pago envia x-signature e x-request-id.
  const secret=process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if(secret){
    const sig=String(req.headers["x-signature"]||"");
    const reqId=String(req.headers["x-request-id"]||"");
    const dataId=String(req.query["data.id"]||req.body?.data?.id||"");
    const ts=(sig.match(/(?:^|,)ts=([^,]+)/)||[])[1];
    const v1=(sig.match(/(?:^|,)v1=([^,]+)/)||[])[1];
    if(!ts||!v1||!reqId||!dataId) return res.sendStatus(401);
    const manifest=`id:${dataId};request-id:${reqId};ts:${ts};`;
    const expected=crypto.createHmac("sha256",secret).update(manifest).digest("hex");
    if(!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(v1)))return res.sendStatus(401);
  }
  res.sendStatus(200);
  const orderId=req.body?.data?.id||req.query["data.id"];
  if(!orderId)return;
  const order=await getOrder(orderId);
  const paid=order?.status==="processed"||order?.status==="approved"||order?.transactions?.payments?.some(p=>p.status==="processed");
  if(paid){
    const regId=order.external_reference;
    await updateRegistrationPaid(regId,orderId,"PAGO");
  }
 }catch(e){console.error("Webhook:",e)}
});

app.listen(PORT,()=>console.log(`Backend rodando na porta ${PORT}`));