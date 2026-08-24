const express=require('express');

const {chatCompletions}=require('../controllers/chat.controller')
const {authenticate}=require('../middleware/auth.middleware')
const {checkBudget}=require('../middleware/budget.middleware')
const {rateLimit}=require('../middleware/rateLimit.middleware')
const router=express.Router();

router.post('/chat/completions',authenticate,rateLimit,checkBudget,chatCompletions);

module.exports=router;