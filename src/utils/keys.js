const crypto=require('crypto');

function generateKey(){
    return `gw_${crypto.randomBytes(24).toString('hex')}`;
}

function hashKey(key){
    return crypto.createHash('sha256').update(key).digest('hex');
}

module.exports={generateKey,hashKey};