require('dotenv').config();

const mongoose=require('mongoose');
const User=require('../src/models/user.model');
const VirtualKey = require('../src/models/virtualKey.model');
const { generateKey, hashKey } = require('../src/utils/keys');

async function seed(){
    await mongoose.connect(process.env.MONGO_URI);

    const user=await User.create({
        name:'Sunil',
        email:'sunilthati27cs@gmail.com',
        role:'admin',
    });

    const key=generateKey();
      await VirtualKey.create({
    userId: user._id,
    name: 'local-testing',
    keyHash: hashKey(key),
    keyPrefix: key.slice(0, 12),
    budgetLimitMicros: 5_000_000,
    period: 'monthly',
  });

  console.log('\nVirtual key (shown once, copy it now):');
  console.log(key, '\n');

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});