// Compatibility entry point for older local shortcuts.
const command=process.argv[2]??'status';
if(!['on','status'].includes(command))throw new Error('法庭界面已固定启用，不再支持关闭或切换。');
console.log('法庭界面：固定启用。');
