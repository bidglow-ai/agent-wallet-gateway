import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {PaymentError} from './intent.mjs';
import {PaymentStoreError} from './store.mjs';
const ID='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ROUTE=new RegExp('^/v1/orders/('+ID+')(?:/(pay|reconcile))?$');
const digest=value=>createHash('sha256').update(value).digest();
function token(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new PaymentError('SCOPED_BROKER_TOKEN_REQUIRED');return value;}

// Local authenticated transport: each instance is bound to ONE pre-authorized
// broker/grant. It never accepts CDP keys, sessions, grants, arbitrary typed data
// or caller-supplied orders. Browser requests and public network use are rejected.
export function createBrokerHttpServer({broker,orderProvider,clientToken}){
  const expected=digest(token(clientToken));let inFlight=0;
  const server=http.createServer(async(req,res)=>{
    const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});res.end(JSON.stringify(value));};
    const port=server.address()?.port,match=ROUTE.exec(req.url||'');
    if(req.headers.host!==`127.0.0.1:${port}`||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.headers.origin!==undefined)return reply(403,{error:'LOCAL_BROKER_REQUEST_REJECTED'});
    const auth=req.headers.authorization;
    if(typeof auth!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)||!timingSafeEqual(expected,digest(auth.slice(7))))return reply(401,{error:'BROKER_AUTHENTICATION_REQUIRED'});
    if(inFlight>=16)return reply(429,{error:'BROKER_BUSY',automaticRetryAllowed:false});
    if((req.url!=='/v1/status'&&!match)||
      (req.method!=='GET'&&req.method!=='POST')||
      (req.method==='POST'&&(!match?.[2]||req.headers['content-type']!=='application/json'))||
      (req.method==='GET'&&match?.[2]))return reply(400,{error:'INVALID_BROKER_REQUEST'});
    inFlight++;
    try{
      if(req.method==='POST'){
        let bytes=0;const chunks=[];
        for await(const chunk of req){bytes+=chunk.length;if(bytes>1024)return reply(413,{error:'INVALID_BROKER_REQUEST'});chunks.push(chunk);}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new PaymentError('INVALID_BROKER_REQUEST');}
        if(!body||Object.getPrototypeOf(body)!==Object.prototype||Object.keys(body).length!==0)throw new PaymentError('INVALID_BROKER_REQUEST');
      }
      if(req.url==='/v1/status')return reply(200,{testnetOnly:true,mainnetEnabled:false,fundingAccepted:false});
      const [,_id,operation]=match;
      if(operation==='pay'){
        const order=await orderProvider.get(_id);
        if(!order||order.id!==_id)throw new PaymentError('AUTHENTICATED_ORDER_REQUIRED');
        return reply(200,await broker.pay(order));
      }
      if(operation==='reconcile')return reply(200,await broker.reconcile(_id));
      return reply(200,await broker.inspect(_id));
    }catch(error){return reply(409,{error:error instanceof PaymentError||error instanceof PaymentStoreError?error.code:'BROKER_OPERATION_UNCONFIRMED',automaticRetryAllowed:false});}
    finally{inFlight--;}
  });
  server.headersTimeout=10000;server.requestTimeout=15000;server.timeout=60000;server.maxRequestsPerSocket=100;
  return server;
}

// MCP adapters receive this scoped token only, never the developer credentials.
// No automatic retries, redirects, provider signing access or arbitrary URLs.
export class BrokerHttpClient {
  #origin;#token;#fetch;
  constructor({origin,clientToken,transport=fetch}){
    let parsed;try{parsed=new URL(origin);}catch{throw new PaymentError('LOCAL_BROKER_ORIGIN_REQUIRED');}
    if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||!parsed.port||parsed.origin!==origin||parsed.username||parsed.password)throw new PaymentError('LOCAL_BROKER_ORIGIN_REQUIRED');
    this.#origin=origin;this.#token=token(clientToken);this.#fetch=transport;
  }
  async #request(id,operation){
    if(typeof id!=='string'||!new RegExp('^'+ID+'$').test(id))throw new PaymentError('INVALID_ORDER_ID');
    let response;
    try{response=await this.#fetch(`${this.#origin}/v1/orders/${id}${operation?'/'+operation:''}`,{method:operation?'POST':'GET',
      headers:{Authorization:'Bearer '+this.#token,...(operation?{'Content-Type':'application/json'}:{})},...(operation?{body:'{}'}:{}),redirect:'error',signal:AbortSignal.timeout(60000)});
      if(!response.ok||!response.headers.get('Content-Type')?.startsWith('application/json'))throw new Error();
      return await response.json();
    }catch{throw new PaymentError('BROKER_OUTCOME_UNCONFIRMED_USE_STATUS');}
  }
  pay(order){return this.#request(order?.id,'pay');}
  inspect(id){return this.#request(id);}
  reconcile(id){return this.#request(id,'reconcile');}
}
