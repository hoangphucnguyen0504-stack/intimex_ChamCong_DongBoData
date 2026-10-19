import {randomBytes} from 'node:crypto';
import {Fault,digest,equal,passwordMatches} from './core.js';
export function authFor(pool,config) {
  const cookie=req=>String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('dd_session='))?.slice(11)||'';
  const sessionHash=req=>digest(cookie(req)+config.SESSION_SECRET);
  const csrf=(req,res,next)=>{
    if(!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin!==config.PUBLIC_ORIGIN)return next(new Fault(403,'ORIGIN_REJECTED','Origin không hợp lệ.'));
    next();
  };
  const admin=async(req,res,next)=>{
    try {
      const [[s]]=await pool.query('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>UTC_TIMESTAMP(3)',[sessionHash(req)]);
      if(!s)throw new Fault(401,'LOGIN_REQUIRED','Vui lòng đăng nhập.');
      next();
    } catch(e){next(e);}
  };
  const integration=(req,res,next)=>{
    if(!equal(req.headers.authorization,`Bearer ${config.API_TOKEN}`))return next(new Fault(401,'API_TOKEN_INVALID'));
    next();
  };
  const login=async(req,res)=>{
    const hash=digest(req.socket.remoteAddress+config.SESSION_SECRET);
    await pool.query(`INSERT INTO login_limits(ip_hash,hits,expires_at) VALUES(?,1,UTC_TIMESTAMP(3)+INTERVAL 5 MINUTE)
      ON DUPLICATE KEY UPDATE hits=IF(expires_at<UTC_TIMESTAMP(3),1,hits+1),expires_at=IF(expires_at<UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)+INTERVAL 5 MINUTE,expires_at)`,[hash]);
    const [[r]]=await pool.query('SELECT hits FROM login_limits WHERE ip_hash=?',[hash]);
    if(r.hits>10) {res.set('Retry-After','300');throw new Fault(429,'LOGIN_RATE_LIMIT','Thử lại sau 5 phút.');}
    if(typeof req.body?.password!=='string'||req.body.password.length>200||!equal(req.body.username,config.ADMIN_USERNAME)||!passwordMatches(req.body.password,config.ADMIN_PASSWORD_HASH))throw new Fault(401,'LOGIN_INVALID','Tài khoản hoặc mật khẩu không đúng.');
    const token=randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions(token_hash,expires_at) VALUES(?,UTC_TIMESTAMP(3)+INTERVAL 8 HOUR)',[digest(token+config.SESSION_SECRET)]);
    res.cookie('dd_session',token,{httpOnly:true,sameSite:'strict',secure:config.COOKIE_SECURE==='true',maxAge:8*3600000,path:'/'}).json({ok:true});
  };
  const logout=async(req,res)=>{
    await pool.query('DELETE FROM sessions WHERE token_hash=?',[sessionHash(req)]);
    res.clearCookie('dd_session',{path:'/',httpOnly:true,sameSite:'strict',secure:config.COOKIE_SECURE==='true'}).json({ok:true});
  };
  return {csrf,admin,integration,login,logout};
}
