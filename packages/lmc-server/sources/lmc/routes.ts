import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/storage/db';
import { lmcAuth, authRevocations } from './auth';

const digest = (s:string)=>createHash('sha256').update(s).digest('hex');
const keySchema=z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const requestSchema=z.object({publicKey:keySchema,pollSecret:z.string().regex(/^[A-Za-z0-9_-]{43}$/),supportsV2:z.boolean().optional()});
const cookieToken=(request:FastifyRequest)=>request.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('lmc_session='))?.slice(12)||'';
const bearer=(request:FastifyRequest)=>request.headers.authorization?.replace(/^Bearer /,'')||'';
const expired=(date:Date)=>date.getTime()<Date.now()-10*60_000;

export function lmcAuthRoutes(app:FastifyInstance<any, any, any, any>) {
    const origin=new URL(process.env.LMC_PUBLIC_ORIGIN||'http://127.0.0.1:4193').origin;
    if (!origin.startsWith('https:') && !['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname)) throw new Error('Public LMC origin requires HTTPS');
    const cookie=(token:string,maxAge:number)=>`lmc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith('https:')?'; Secure':''}`;
    const attempts=new Map<string,{count:number,until:number}>();
    app.addHook('onRequest',async(req,reply)=>{
        if(req.headers.origin&&req.headers.origin!==origin)return reply.code(403).send({error:'请求来源无效'});
    });
    app.addHook('onRequest',async(req,reply)=>{if(req.url.startsWith('/v1/lmc')||req.url.startsWith('/v1/auth'))reply.header('Cache-Control','no-store');});
    app.post('/v1/lmc/login',async(req,reply)=>{
        if(req.headers.origin!==origin)return reply.code(403).send({error:'请求来源无效'});
        const now=Date.now(); for(const [key,value] of attempts)if(value.until<=now)attempts.delete(key);
        const count=attempts.get(req.ip)||{count:0,until:now+15*60_000};
        if(count.count>=10||attempts.size>=10000)return reply.code(429).send({error:'尝试次数过多，请稍后重试'});
        count.count++;attempts.set(req.ip,count);
        const parsed=z.object({username:z.string().min(1).max(64),password:z.string().max(256)}).safeParse(req.body);
        if(!parsed.success)return reply.code(400).send({error:'请输入账号和密码'});
        const result=await lmcAuth.login(parsed.data.username,parsed.data.password);
        if(!result)return reply.code(401).send({error:'账号或密码错误'});
        attempts.delete(req.ip);reply.header('Set-Cookie',cookie(result.token,30*86400));return result;
    });
    app.get('/v1/lmc/session',async(req,reply)=>{
        const credentials=await lmcAuth.browserCredentials(cookieToken(req));
        return credentials||reply.code(401).send({error:'请登录'});
    });
    app.post('/v1/lmc/logout',async(req,reply)=>{
        if(req.headers.origin!==origin)return reply.code(403).send({error:'请求来源无效'});
        await lmcAuth.invalidateToken(cookieToken(req));reply.header('Set-Cookie',cookie('',0));return {success:true};
    });
    app.post('/v1/auth',async(_req,reply)=>reply.code(410).send({error:'请使用 LMC 账号登录或在浏览器配对设备'}));
    app.post('/v1/auth/request',async(req,reply)=>{
        const parsed=requestSchema.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'Invalid pairing request'});
        const {publicKey,pollSecret,supportsV2}=parsed.data,hex=Buffer.from(publicKey,'base64').toString('hex');
        const existing=await db.terminalAuthRequest.findUnique({where:{publicKey:hex}});
        if(existing&&(existing.consumedAt||expired(existing.createdAt)))return reply.code(410).send({error:'配对已失效，请重新发起'});
        // Bound unapproved requests without an unbounded public registration table.
        if(!existing){
            await db.terminalAuthRequest.deleteMany({where:{createdAt:{lt:new Date(Date.now()-10*60_000)}}});
            if(await db.terminalAuthRequest.count()>=1000)return reply.code(429).send({error:'Too many pending requests'});
        }
        const record=await db.terminalAuthRequest.upsert({where:{publicKey:hex},update:{},create:{publicKey:hex,pollHash:digest(pollSecret),supportsV2:supportsV2??false}});
        if(record.pollHash!==digest(pollSecret))return reply.code(401).send({error:'Pairing proof invalid'});
        if(!record.response||!record.responseAccountId)return {state:'requested'};
        const claimed=await db.terminalAuthRequest.updateMany({where:{id:record.id,consumedAt:null},data:{consumedAt:new Date()}});
        if(!claimed.count)return reply.code(410).send({error:'配对已完成'});
        return {state:'authorized',response:record.response,token:await lmcAuth.createToken(record.responseAccountId,{pairing:record.id})};
    });
    app.get('/v1/auth/request/status',async(req,reply)=>{
        const user=await lmcAuth.verifyToken(bearer(req));if(!user||user.kind!=='web')return reply.code(401).send({error:'请登录'});
        const parsed=z.object({publicKey:keySchema}).safeParse(req.query);if(!parsed.success)return reply.code(400).send({error:'Invalid public key'});
        const record=await db.terminalAuthRequest.findUnique({where:{publicKey:Buffer.from(parsed.data.publicKey,'base64').toString('hex')}});
        if(!record||expired(record.createdAt)||record.consumedAt)return {status:'not_found',supportsV2:false};
        return {status:record.response?'authorized':'pending',supportsV2:record.supportsV2};
    });
    app.post('/v1/auth/response',async(req,reply)=>{
        const user=await lmcAuth.verifyToken(bearer(req));if(!user||user.kind!=='web')return reply.code(401).send({error:'请登录'});
        const parsed=z.object({publicKey:keySchema,response:z.string().min(1).max(8192)}).safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'Invalid response'});
        const changed=await db.terminalAuthRequest.updateMany({where:{publicKey:Buffer.from(parsed.data.publicKey,'base64').toString('hex'),createdAt:{gt:new Date(Date.now()-10*60_000)},response:null,consumedAt:null},data:{response:parsed.data.response,responseAccountId:user.userId}});
        return changed.count?{success:true}:reply.code(409).send({error:'配对已失效或已被处理'});
    });
    app.post('/v1/lmc/device/logout',async(req,reply)=>{
        const token=bearer(req), user=await lmcAuth.verifyToken(token);
        if(!user||user.kind!=='device')return reply.code(401).send({error:'设备授权已失效'});
        await lmcAuth.invalidateToken(token);return {success:true};
    });
    app.get('/v1/lmc/devices',async(req,reply)=>{
        const user=await lmcAuth.verifyToken(bearer(req));if(!user||user.kind!=='web')return reply.code(401).send({error:'请登录'});
        const devices=await db.lmcLogin.findMany({where:{accountId:user.userId,kind:'device'},select:{hash:true,createdAt:true,expiresAt:true,extras:true}});
        return {devices:devices.map(({hash,...rest})=>({id:hash,...rest}))};
    });
    app.delete('/v1/lmc/devices/:id',async(req,reply)=>{
        const user=await lmcAuth.verifyToken(bearer(req));if(!user||user.kind!=='web')return reply.code(401).send({error:'请登录'});
        const {id}=req.params as {id:string};
        const result=await db.lmcLogin.deleteMany({where:{hash:id,accountId:user.userId,kind:'device'}});
        if(!result.count)return reply.code(404).send({error:'设备不存在'});
        authRevocations.emit('hash',id);return {success:true};
    });
}
