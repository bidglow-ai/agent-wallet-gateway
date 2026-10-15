import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {NETWORK,TOKEN,validateGrant,PaymentError} from './intent.mjs';
import {PaymentStoreError} from './store.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONCE=/^[A-Za-z0-9_-]{43}$/;
function fields(value,names){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==[...names].sort().join('|'))throw new PaymentError('INVALID_ENROLLMENT_REQUEST');
  const out={};for(const key of names){const property=Object.getOwnPropertyDescriptor(value,key);if(!property||!('value' in property))throw new PaymentError('INVALID_ENROLLMENT_REQUEST');out[key]=property.value;}return out;
}
function identity(value,wallet,delegated=true){
  if(!value||!UUID.test(value.userId)||value.wallet!==wallet||
    (delegated&&(!Number.isSafeInteger(value.delegationExpiresAt)||value.delegationExpiresAt<=Date.now()||value.delegationExpiresAt>Date.now()+86400000)))throw new PaymentError('AUTHENTICATED_ENROLLMENT_REQUIRED');
  return value;
}
function localOrigin(value,allowLocalhost=false){
  let parsed;try{parsed=new URL(value);}catch{throw new PaymentError('LOCAL_ONBOARDING_ORIGIN_REQUIRED');}
  if(parsed.protocol!=='http:'||!(parsed.hostname==='127.0.0.1'||allowLocalhost&&parsed.hostname==='localhost')||!parsed.port||parsed.origin!==value||parsed.username||parsed.password)throw new PaymentError('LOCAL_ONBOARDING_ORIGIN_REQUIRED');
  return value;
}

// A trusted self-hosted process enrolls ONE operator-selected empty development
// wallet. The UI cannot supply a subject, grant ID, path, cap, merchant or expiry.
// Authentication alone never authorizes payments: a short-lived proposal must
// be displayed and explicitly confirmed. No per-purchase human prompt follows.
export class EnrollmentAuthority {
  #signer;#registry;#config;#activate;#stop;#recover;#pending=new Map();#stopped=false;
  constructor({signer,registry,config,activate,revoke,recover}){
    fields(config,['projectId','expectedWallet','payTo','merchantOrigin','perCallAtomic','totalAtomic','durationMs']);
    if(!UUID.test(config.projectId)||![3600000,14400000,86400000].includes(config.durationMs)||typeof activate!=='function'||typeof revoke!=='function')throw new PaymentError('DEVELOPMENT_ENROLLMENT_CONFIGURATION_REQUIRED');
    validateGrant({grantId:randomUUID(),userId:randomUUID(),wallet:config.expectedWallet,network:NETWORK,asset:TOKEN,
      payTo:config.payTo,merchantOrigin:config.merchantOrigin,perCallAtomic:config.perCallAtomic,totalAtomic:config.totalAtomic,expiresAt:Date.now()+config.durationMs});
    this.#signer=signer;this.#registry=registry;this.#config=Object.freeze({...config});this.#activate=activate;this.#stop=revoke;this.#recover=recover;
  }
  async #authenticate(accessToken,wallet,delegated=true){
    if(wallet!==this.#config.expectedWallet)throw new PaymentError('OPERATOR_SELECTED_WALLET_REQUIRED');
    const method=delegated?'verifyEnrollment':'verifySession';
    return identity(await this.#signer[method]({accessToken,wallet}),wallet,delegated);
  }
  async propose(accessToken,input){
    const {wallet}=fields(input,['wallet']);
    const subject=await this.#authenticate(accessToken,wallet),now=Date.now();
    if(this.#stopped)throw new PaymentError('MANDATE_REVOKED');
    for(const [key,value]of this.#pending)if(value.deadline<=now)this.#pending.delete(key);
    if(this.#pending.size>=8)throw new PaymentError('ENROLLMENT_BUSY');
    const existing=this.#registry.get();
    const grant=existing||validateGrant({grantId:randomUUID(),userId:subject.userId,wallet,network:NETWORK,asset:TOKEN,
      payTo:this.#config.payTo,merchantOrigin:this.#config.merchantOrigin,perCallAtomic:this.#config.perCallAtomic,
      totalAtomic:this.#config.totalAtomic,expiresAt:Math.min(subject.delegationExpiresAt,now+this.#config.durationMs)});
    this.#assertGrant(grant,subject);
    const nonce=randomBytes(32).toString('base64url'),deadline=Math.min(now+120000,grant.expiresAt);
    this.#pending.set(nonce,{grant,deadline});
    return {nonce,challengeExpiresAt:deadline,grant,existing:!!existing,testnetOnly:true,mainnetEnabled:false,fundingAccepted:false};
  }
  #assertGrant(grant,subject){
    const g=validateGrant(grant),c=this.#config;
    if(g.userId!==subject.userId||g.wallet!==subject.wallet||g.wallet!==c.expectedWallet||g.payTo!==c.payTo||g.merchantOrigin!==c.merchantOrigin||
      g.perCallAtomic!==c.perCallAtomic||g.totalAtomic!==c.totalAtomic||g.expiresAt>Date.now()+c.durationMs||
      g.expiresAt>subject.delegationExpiresAt||g.expiresAt<=Date.now())throw new PaymentError('MANDATE_IDENTITY_OR_SCOPE_MISMATCH');
    return g;
  }
  async confirm(accessToken,input){
    const {wallet,nonce,approved}=fields(input,['wallet','nonce','approved']);
    if(approved!==true||!NONCE.test(nonce))throw new PaymentError('EXPLICIT_MANDATE_CONSENT_REQUIRED');
    const pending=this.#pending.get(nonce);this.#pending.delete(nonce);
    if(!pending||pending.deadline<=Date.now())throw new PaymentError('MANDATE_PROPOSAL_EXPIRED_OR_USED');
    const subject=await this.#authenticate(accessToken,wallet);
    if(this.#stopped)throw new PaymentError('MANDATE_REVOKED');
    const grant=this.#assertGrant(pending.grant,subject);
    const enrolled=this.#registry.enroll(subject,grant);
    const connection=await this.#activate(enrolled.grant);
    if(this.#stopped)throw new PaymentError('MANDATE_REVOKED');
    localOrigin(connection?.brokerOrigin);
    if(!NONCE.test(connection.clientToken))throw new PaymentError('BROKER_ACTIVATION_UNCONFIRMED');
    // Sensitive restricted capability goes only to the authenticated owner.
    // Never log it, put it in a URL, persist it in the UI, or return provider keys.
    return {grant:enrolled.grant,agentConnection:{brokerOrigin:connection.brokerOrigin,clientToken:connection.clientToken},
      testnetOnly:true,mainnetEnabled:false,fundingAccepted:false};
  }
  async revoke(accessToken,input){
    const {wallet,approved}=fields(input,['wallet','approved']);
    if(approved!==true)throw new PaymentError('EXPLICIT_MANDATE_CONSENT_REQUIRED');
    // Session authentication does not require a still-active delegation. A user
    // must be able to stop the local mandate after provider delegation expires.
    const subject=await this.#authenticate(accessToken,wallet,false),grant=this.#registry.get();
    if(!grant||grant.userId!==subject.userId||grant.wallet!==subject.wallet)throw new PaymentError('MANDATE_NOT_FOUND');
    this.#stopped=true;this.#pending.clear();
    return await this.#stop(grant);
  }
  async recover(accessToken,input){
    const {wallet,approved}=fields(input,['wallet','approved']);
    if(approved!==true)throw new PaymentError('EXPLICIT_RECOVERY_CONSENT_REQUIRED');
    const subject=await this.#authenticate(accessToken,wallet,false),grant=this.#registry.get();
    if(!grant||grant.userId!==subject.userId||grant.wallet!==subject.wallet)throw new PaymentError('MANDATE_NOT_FOUND');
    if(typeof this.#recover!=='function')throw new PaymentError('RECOVERY_SERVICE_UNAVAILABLE');
    const connection=await this.#recover(grant);
    localOrigin(connection?.brokerOrigin);
    if(!NONCE.test(connection.clientToken))throw new PaymentError('BROKER_ACTIVATION_UNCONFIRMED');
    return {grant,agentConnection:{brokerOrigin:connection.brokerOrigin,clientToken:connection.clientToken},recoveryOnly:true,
      testnetOnly:true,mainnetEnabled:false,fundingAccepted:false};
  }
}

// Separate browser enrollment listener; never mount these routes on the agent
// payment listener. Exact Origin + JSON + bearer session, no cookies or wildcard
// CORS. Loopback is a development trust boundary, not a public HTTPS service.
export function createEnrollmentHttpServer({authority,onboardingOrigin}){
  // Coinbase's development allowlist requires a domain, not an IP. A configured
  // localhost browser Origin is allowed here only; broker capabilities remain
  // literal 127.0.0.1 endpoints and request Origin matching stays byte-exact.
  const allowed=localOrigin(onboardingOrigin,true);let inFlight=0;
  const server=http.createServer(async(req,res)=>{
    const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Vary':'Origin',
      ...(req.headers.origin===allowed?{'Access-Control-Allow-Origin':allowed}: {})});res.end(JSON.stringify(value));};
    if(req.headers.host!==`127.0.0.1:${server.address()?.port}`||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.headers.origin!==allowed)return reply(403,{error:'LOCAL_ENROLLMENT_REQUEST_REJECTED'});
    const action=new Map([['/enrollment/v1/proposal','propose'],['/enrollment/v1/confirm','confirm'],['/enrollment/v1/revoke','revoke'],['/enrollment/v1/recover','recover']]).get(req.url);
    if(!action)return reply(404,{error:'INVALID_ENROLLMENT_REQUEST'});
    if(req.method==='OPTIONS'){
      const headers=req.headers['access-control-request-headers']?.toLowerCase().split(',').map(v=>v.trim()).sort().join(',');
      if(req.headers['access-control-request-method']!=='POST'||headers!=='authorization,content-type')return reply(403,{error:'INVALID_ENROLLMENT_PREFLIGHT'});
      res.writeHead(204,{'Access-Control-Allow-Origin':allowed,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Authorization, Content-Type','Vary':'Origin','Cache-Control':'no-store'});return res.end();
    }
    if(req.method!=='POST'||req.headers['content-type']!=='application/json')return reply(400,{error:'INVALID_ENROLLMENT_REQUEST'});
    const auth=req.headers.authorization;
    if(typeof auth!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,16384}$/.test(auth))return reply(401,{error:'AUTHENTICATED_ENROLLMENT_REQUIRED'});
    if(inFlight>=8)return reply(429,{error:'ENROLLMENT_BUSY'});
    inFlight++;
    try{
      let bytes=0;const chunks=[];
      for await(const chunk of req){bytes+=chunk.length;if(bytes>2048)return reply(413,{error:'INVALID_ENROLLMENT_REQUEST'});chunks.push(chunk);}
      let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new PaymentError('INVALID_ENROLLMENT_REQUEST');}
      return reply(200,await authority[action](auth.slice(7),input));
    }catch(error){return reply(409,{error:error instanceof PaymentError||error instanceof PaymentStoreError?error.code:'ENROLLMENT_OPERATION_UNCONFIRMED',automaticRetryAllowed:false});}
    finally{inFlight--;}
  });
  server.headersTimeout=10000;server.requestTimeout=15000;server.timeout=60000;server.maxRequestsPerSocket=100;
  return server;
}
