import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import gateway from './gateway.js';

test('gateway enforces host, method, signed audience, expiry and email before every asset',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const jwk=await exportJWK(publicKey);jwk.kid='fictional-key';jwk.alg='RS256';jwk.use='sig';
  const originalFetch=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(url)=>{
    assert.equal(String(url),'https://fictional-juliet.cloudflareaccess.com/cdn-cgi/access/certs');
    return new Response(JSON.stringify({keys:[jwk]}),{headers:{'Content-Type':'application/json'}});
  };
  try{
    const env={ACCESS_ISSUER:'https://fictional-juliet.cloudflareaccess.com',ACCESS_AUDIENCE:'fictional-audience',REVIEW_EMAILS:'reviewer@example.invalid',ASSETS:{fetch:async request=>{calls.push(request.url);return new Response('asset');}}};
    const token=async(patch={})=>new SignJWT({email:'reviewer@example.invalid',...patch}).setProtectedHeader({alg:'RS256',kid:'fictional-key'}).setIssuedAt().setIssuer(env.ACCESS_ISSUER).setAudience(patch.aud||env.ACCESS_AUDIENCE).setExpirationTime(patch.exp??'5m').sign(privateKey);
    const request=(jwt,host='review.ymroue.com',method='GET')=>new Request('https://'+host+'/runtime.json',{method,headers:jwt?{'Cf-Access-Jwt-Assertion':jwt}:{}});
    for(const req of [request(null),request('forged'),request(await token(),'other.invalid'),request(await token({aud:'other-audience'})),request(await token({email:'someone@example.invalid'})),request(await token({exp:1}))]){
      const response=await gateway.fetch(req,env);assert.equal(response.status,403);assert.equal(response.headers.get('Cache-Control'),'no-store');
    }
    assert.equal((await gateway.fetch(request(await token(),'review.ymroue.com','POST'),env)).status,405);
    assert.equal(calls.length,0);
    for(const method of ['GET','HEAD'])assert.equal((await gateway.fetch(request(await token(),'review.ymroue.com',method),env)).status,200);
    assert.equal(calls.length,2);
    assert.equal((await gateway.fetch(request(await token()),{...env,REVIEW_EMAILS:''})).status,403);
  }finally{globalThis.fetch=originalFetch;}
});
