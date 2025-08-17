// Script to reproduce the extension activation issue
// This simulates the extension activation process to identify blocking operations

const vscode = {
  // Mock VSCode API to simulate the problematic behavior
  lm: {
    selectChatModels: async (options) => {
      console.log('🔄 Calling vscode.lm.selectChatModels...');
      // Simulate a hanging or slow response that causes the extension to get stuck
      return new Promise((resolve, reject) => {
        // This simulates the case where the API call hangs indefinitely
        // In real scenarios, this could be due to:
        // 1. No LLM models available
        // 2. Network issues
        // 3. VSCode API not responding
        setTimeout(() => {
          console.log('⚠️  selectChatModels is taking too long...');
          // Uncomment to simulate a successful but slow response:
          // resolve([]);
          // 
          // Keep it hanging to simulate the actual issue:
          // (never resolves)
        }, 5000);
      });
    }
  },
  workspace: {
    getConfiguration: (section) => ({
      get: (key, defaultValue) => defaultValue
    })
  },
  window: {
    showInformationMessage: (msg) => console.log('INFO:', msg),
    showWarningMessage: (msg) => console.log('WARN:', msg),
    showErrorMessage: (msg) => console.log('ERROR:', msg)
  }
};

// Simulate the problematic activation function
async function simulateActivation() {
  console.log('🚀 Starting extension activation...');
  
  // This is the problematic part from extension.ts lines 227-257
  async function updateModelCacheAndRefreshUI() {
    let didFinish = false;
    try {
      console.log('📋 Updating model cache...');
      const timeout = setTimeout(() => {
        if (!didFinish) {
          console.error('❌ Model cache update timed out (10s)');
        }
      }, 10000);
      
      // This is the line that can cause the extension to hang
      const models = await vscode.lm.selectChatModels({});
      console.log('✅ Models fetched:', models);
      
      didFinish = true;
      clearTimeout(timeout);
      console.log('✅ Model cache update complete.');
    } catch (err) {
      console.error('❌ Model cache update error:', err);
    }
  }

  // Simulate the immediate call
  setTimeout(() => {
    console.log('🔄 Starting immediate model cache update...');
    updateModelCacheAndRefreshUI().catch(err => 
      console.error('❌ Immediate cache update failed:', err)
    );
  }, 0);

  // Simulate the delayed call  
  setTimeout(() => {
    console.log('🔄 Starting delayed model cache update...');
    updateModelCacheAndRefreshUI().catch(err => 
      console.error('❌ Delayed cache update failed:', err)
    );
  }, 3000);
  
  console.log('✅ Extension activation "completed" (but async operations still running...)');
}

// Run the simulation
simulateActivation().then(() => {
  console.log('🎯 Simulation finished - extension should be stuck now');
}).catch(err => {
  console.error('💥 Simulation failed:', err);
});

// Keep the process alive to see the timeout behavior
setTimeout(() => {
  console.log('⏰ 15 seconds have passed - extension would still show "activating"');
  process.exit(0);
}, 15000);