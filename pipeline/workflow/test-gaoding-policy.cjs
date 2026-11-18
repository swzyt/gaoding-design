const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../publish_flow');
const {validatePublishedMetadata} = require('./publish');

const photo = {id:'official-photo',type:'image',copyright_category:'gaoding'};
const recipe = layers => ({topic_kind:'topic',topic:'小红书大字封面',layers});

test('official photography retains gaoding provenance and non-AI disclosure', () => {
  assert.deepEqual(flow.publicationPolicy({...recipe([photo,{...photo,id:'second'},{type:'text'}]),containsAI:true}), {
    topicKind:'topic',containsAI:false,categories:['gaoding'],
  });
  assert.equal(flow.publicationPolicy({layers:[photo]}).topicKind,'activity');
});

test('official photography mixes with program shapes or PNGs without claiming AI', () => {
  const layers = [photo,{id:'footer',type:'image',copyright_category:'original'},
    {id:'rule',type:'shape',copyright_category:'original'},{type:'text'}];
  assert.deepEqual(flow.publicationPolicy(recipe(layers)), {
    topicKind:'topic',containsAI:false,categories:['gaoding','original'],
  });
  assert.deepEqual(flow.publicationPolicy({...recipe([...layers,{type:'image',copyright_category:'original_ai'},
    {type:'image',copyright_category:'non_original'}]),containsAI:false}), {
    topicKind:'topic',containsAI:true,categories:['gaoding','non_original','original','original_ai'],
  });
});

test('gaoding does not relax unknown provenance, material type, topic or legacy guards', async () => {
  for (const layer of [{type:'image'},{type:'image',copyright_category:'stock'},
    {type:'image',copyright_category:'Gaoding'},{type:'vector',copyright_category:'gaoding'}]) {
    assert.throws(() => flow.publicationPolicy(recipe([photo,layer])), /Unsupported material type|unsupported material provenance/);
  }
  assert.throws(() => flow.publicationPolicy({...recipe([photo]),topic_kind:'other'}), /topic_kind/);
  assert.throws(() => flow.publicationPolicy({containsAI:'false'}), /explicit containsAI/);
  for (const layers of [[photo],[photo,{type:'shape',copyright_category:'original'}]]) {
    await assert.rejects(() => flow.run({recipe:recipe(layers),evidence:['proof.png'],copyrightCategory:'original'}), /one explicit source category/);
  }
  const untouched = new Proxy({}, {get(){throw Error('Must reject before browser interaction');}});
  await assert.rejects(() => flow.copyright(untouched,()=>{},[],'gaoding'), /explicit material source category/);
});

test('published metadata must still match official-photo AI disclosure and topic', () => {
  const input = recipe([photo]);
  const payload = {ugc_topics:[{id:'actual-topic-id',name:input.topic}],user_marked_aigc:false};
  assert.equal(validatePublishedMetadata(input,{payload}).aiDisclosureVerified,true);
  assert.throws(() => validatePublishedMetadata(input,{payload:{...payload,user_marked_aigc:true}}), /provenance/);
  assert.throws(() => validatePublishedMetadata(input,{payload:{...payload,ugc_topics:[{id:'other',name:'其它话题'}]}}), /provenance/);
  const mixed = recipe([photo,{type:'image',copyright_category:'original_ai'}]);
  assert.throws(() => validatePublishedMetadata(mixed,{payload}), /provenance/);
  assert.equal(validatePublishedMetadata(mixed,{payload:{...payload,user_marked_aigc:true}}).aiDisclosureVerified,true);
});
