import {it,expect} from 'vitest';
import {collectOperations} from '../src/runner';
const operation = {responses:{'200':{description:'OK',content:{'application/json':{schema:{type:'object',properties:{id:{type:'string'}}}}}}}};
const spec: any = {openapi:'3.2.0',info:{title:'Methods',version:'1'},servers:[{url:'https://example.test'}],paths:{'/items':{trace:operation,query:operation,additionalOperations:{PROPFIND:operation,'CUSTOM-VERB':operation}}}};
const expected = ['trace','query','propfind','custom-verb'];
it('preserves QUERY, TRACE and custom operations across consumers',()=>{
expect(collectOperations(spec, {} as any).map(op=>op.method)).toEqual(expected);
});

it('passes multipart entries and file paths through scenario execution',async()=>{
 const http=await import('node:http');const fs=await import('node:fs/promises');const path=await import('node:path');const os=await import('node:os');
 const {runScenario}=await import('../src/scenario');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'scenario-upload-'));
 const file=path.join(directory,'file.txt');await fs.writeFile(file,'scenario-file-bytes');
 let received='';let method='';
 const server=http.createServer(async(req,res)=>{method=req.method!;for await(const chunk of req)received+=chunk.toString();res.end('ok');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const upload={...operation,requestBody:{content:{'multipart/form-data':{schema:{type:'object'}}}}};
  const document={...spec,paths:{'/upload':{additionalOperations:{PROPFIND:upload}}}};
  const report=await runScenario({name:'upload',steps:[{ref:'PROPFIND /upload',request:{values:{body:[['tag','one'],['tag','two'],['file',{__file:file}]]}}}]},{spec:document,config:{specPath:'unused',serverUrl:`http://127.0.0.1:${(server.address() as any).port}`,timeout:5000}});
  expect(report.status).toBe('passed');expect(method).toBe('PROPFIND');expect(received).toContain('scenario-file-bytes');expect(received.match(/name="tag"/g)).toHaveLength(2);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});}
});
