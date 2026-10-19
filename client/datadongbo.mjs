// Chỉ dùng ở backend. Không đưa token này vào ứng dụng trình duyệt.
export class DataDongBoClient {
  constructor({url,token,fetchImpl=fetch,timeoutMs=15000}) {
    const target=new URL(url);
    if(target.protocol!=='https:'&&!['localhost','127.0.0.1','api'].includes(target.hostname))throw Error('DataDongBo cần HTTPS ngoài mạng nội bộ.');
    this.url=url.replace(/\/$/,'');this.token=token;this.fetch=fetchImpl;this.timeoutMs=timeoutMs;
  }
  async request(path,{method='GET',body}={}) {
    const response=await this.fetch(this.url+path,{method,headers:{Authorization:`Bearer ${this.token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(this.timeoutMs)});
    const result=await response.json();
    if(!response.ok)throw Object.assign(Error(result.message||result.code),{status:response.status,code:result.code,current:result.current});
    return result;
  }
  // Khi timeout, giữ nguyên batch và requestId; tra cứu trước khi gửi lại.
  commit(batch){return this.request('/v1/batch',{method:'POST',body:batch});}
  result(requestId){return this.request('/v1/requests/'+encodeURIComponent(requestId));}
  list(entity,query={}){return this.request(`/v1/entities/${encodeURIComponent(entity)}/records?${new URLSearchParams(query)}`);}
  get(entity,id){return this.request(`/v1/entities/${encodeURIComponent(entity)}/records/${encodeURIComponent(id)}`);}
  archive(entity,id){return this.request(`/v1/entities/${encodeURIComponent(entity)}/archive/${encodeURIComponent(id)}`);}
  history(entity,query={}){return this.request(`/v1/entities/${encodeURIComponent(entity)}/archive?${new URLSearchParams(query)}`);}
}
