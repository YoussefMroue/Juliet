// Cloudflare Access runs before this Worker. Require its signed assertion on
// every asset as well, including requests that use an alternate entry point.
import {createRemoteJWKSet,jwtVerify} from 'jose';
let keys, lastIssuer;
export default {
  async fetch(request,env){
    const deny=()=>new Response('Sign-in required.',{status:403,headers:{'Cache-Control':'no-store'}});
    if(new URL(request.url).hostname!=='review.ymroue.com') return deny();
    if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}});
    const token=request.headers.get('Cf-Access-Jwt-Assertion');
    const issuer=env.ACCESS_ISSUER;
    if(!token || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer??'') || !env.ACCESS_AUDIENCE || !env.REVIEW_EMAILS)return deny();
    try{
      if(issuer!==lastIssuer){keys=createRemoteJWKSet(new URL('/cdn-cgi/access/certs',issuer));lastIssuer=issuer;}
      const {payload}=await jwtVerify(token,keys,{issuer,audience:env.ACCESS_AUDIENCE,algorithms:['RS256'],requiredClaims:['exp','email']});
      if(!env.REVIEW_EMAILS.split(',').includes(String(payload.email).toLowerCase()))return deny();
    }catch{return deny();}
    return env.ASSETS.fetch(request);
  }
};
