//ganache-cli --fork --port 9545 https://mainnet.infura.io/v3/46b5f53c4fb7487f8a964120bcfb43ff

const Web3 = require('web3');
const BN = require('bn.js');
const { expectEvent, expectRevert }  = require('@openzeppelin/test-helpers');
const truffleAssert = require('truffle-assertions');

const Token   = artifacts.require("./contracts/token/CommonGoodProjectToken.sol");
const Vault   = artifacts.require("./contracts/vault/CommonGoodVault.sol");
const Project = artifacts.require("./contracts/project/Project.sol");
const Platform = artifacts.require("./contracts/platform/Platform.sol");
const BasicERC20 = artifacts.require("./contracts/test/BasicERC20.sol");


contract("Project", (accounts_) => {

   const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

   const CID_VALUE = '0x4554480000000000000000000000000000000000000000000000000000000000';

   const MILLION = 1000000;

   //  TODO: test external vault/token


   const COIN_UNIT = 'gwei'; //'ether'

   function _toWei( val) {
        return Web3.utils.toWei( val, COIN_UNIT);
   }

   const INITIAL_PLEDGER_PAYMENT_TOKEN_ALLOCATION = _toWei('100');
   const ALLOWANCE_TO_PROJECT           = INITIAL_PLEDGER_PAYMENT_TOKEN_ALLOCATION;

   const MILESTONE_VALUE                = _toWei('1');
   const MIN_PLEDGE_SUM                 = MILESTONE_VALUE;

   const PLEDGE_SUM_1 = _toWei('1');
   const PLEDGE_SUM_2 = _toWei('4');
   const PLEDGE_SUM_3 = _toWei('2');
   const PLEDGE_SUM_4 = _toWei('3');
   const PLEDGE_SUM_5 = _toWei('4');

   //---

   let revertReasonSupported = false;
   let usePredeployedContracts = false;

   let ProjectDeployedAddr;
   let VaultDeployedAddr;
   let ProjectTokenDeployedAddr;
   let PlatformDeployedAddr;

   const MILESTONE_UNRESOLVED = 0;
   const MILESTONE_SUCCEEDED = 1;
   const MILESTONE_FAILED = 2;

   const PROJECT_IN_PROGRESS = 0;
   const PROJECT_SUCCEEDED = 1;
   const PROJECT_FAILED = 2;

   let lastTeamWalletBalance;
   let projectTemplateInst;
   let vaultTemplateInst;
   let tokenInst;
   let platformInst;
   let milestones_;

   let thisProjInstance;
   let thisTeamWallet;
   let thisVaultInstance;

   let paymentTokenInstance; // e.g. usdc

   const addr1 = accounts_[0];
   let   addr2 = accounts_[1];
   let   addr3 = accounts_[2];
   let   addr4 = accounts_[3];




  //======================== test methods ========================

   beforeEach( async function () {
        await createProjectContract();
   });


  it("Create a project", async () => { //
       // to run: truffle test  --network goerli

       // created in beforeEach()
      await verifyProjectMayNotBeReinitialized( milestones_);
  });


  it("executes a successful project", async () => {

      await executeProjectLifecycle(true);

      console.log("successful project test completed");
  });


  it("create a project with large milestone count", async () => {

      await createMultiMilestoneProject( 80);

      console.log("successful large milestone count test completed");
  });


  it("executes a failed project", async () => {

      await executeProjectLifecycle(false);

      console.log("failed project test completed");

  });


  it("fails if a milestone is overdue", async () => {

      await executeProjectWithOverdueMilestone();

      console.log("milestone overdue test completed");

  });


  it("verifies pledgers can bail out with in grace period", async () => {

      await executeProjectWithGracePeriod();

      console.log("grace period test completed");

  });


  it("verifies 'late' pledgers are correctly processed even after some milestones are approved ", async () => {

      await executeProjectWithLatePledgers();

      console.log("late pledgers test completed");

  });


  it("tests multiple project deployment", async () => {

      await createProjectContract();
      await executeProjectLifecycle(false);

      await createProjectContract();
      await executeProjectLifecycle(true);

      await createProjectContract();
      await executeProjectLifecycle(true);

      console.log("failed project with multiple project deployment");

  });


  it("test multi pldege events", async () => {
      let receipt;
      receipt = await invokeNewPledge(  MIN_PLEDGE_SUM, addr1 );
      receipt = await invokeNewPledge(  MIN_PLEDGE_SUM, addr1);
      receipt = await invokeNewPledge(  MIN_PLEDGE_SUM, addr1);
      receipt = await invokeNewPledge(  MIN_PLEDGE_SUM, addr2);
      receipt = await invokeNewPledge(  MIN_PLEDGE_SUM, addr2);

      console.log("multi pldege eventstest completed");
  });

  //------------



   async function loadAllContractInstances() {

        if (usePredeployedContracts) {
            paymentTokenInstance = await Token.at( ProjectTokenDeployedAddr);
            projectTemplateInst  = await Project.at( ProjectDeployedAddr);
            vaultTemplateInst    = await Vault.at( VaultDeployedAddr);
            platformInst         = await Platform.at( PlatformDeployedAddr);
        } else {
            paymentTokenInstance = await Token.deployed(); // deploy a dedicated instance for payment tokens
            projectTemplateInst  = await Project.deployed();
            vaultTemplateInst    = await Vault.deployed();
            platformInst         = await Platform.deployed();
        }

        await mintPaymentTokenToAddress( addr1);

        await mintPaymentTokenToAddress( addr2);

        await mintPaymentTokenToAddress( addr3);
        await mintPaymentTokenToAddress( addr4);

        console.log(`projectTemplateInst: ${projectTemplateInst.address}`);
        console.log(`vault-2: ${vaultTemplateInst.address}`);
        console.log(`platform: ${platformInst.address}`);

        await platformInst.approvePaymentToken( paymentTokenInstance.address, true);

        await markProjectTeamAsBetaTester( addr1);
   }


   async function createProjectContract() {

        const netId = await web3.eth.net.getId();
        console.log(` netId: ${netId}`);

        switch (netId) {
            case 1:
              revertReasonSupported = true;
              console.log('Testing on mainnet (fork?)');
              break

            case 2:
              console.log('Testing on ropsten');
              break

            case 3:
              console.log('Testing on kovan');
              break

            case 4:
              console.log('Testing on Rinkeby');
              addr2 = '0x7214958FC29ACFAd0450C0881EB916AC172435e2';
              addr3 = '0x4d6BF011855d8E36A54A2D04d5B5073C4E125b34';
              addr4 = '0xD268CE34B2a1CD9BD9cC80e4f2d4825d498342dc';
              break

            case 5:
              console.log('Testing on Goerli');
//              usePredeployedContracts = true;
//
//              ProjectDeployedAddr = '0x614474df8ab10Ba043A0aFaF3F2E294DC7F1B985';
//              VaultDeployedAddr = '0x2a17D02EA09394dAe19c6bacf4fec5B1e5e7b6f5';
//              ProjectTokenDeployedAddr = '0xfD385974F961a477dF389FB3bcBA7aa0743d2443';
//              PlatformDeployedAddr = '0x4428288031092ec8a2f0ed27dE7eEEF18Be808F8';
//
//              addr2 = '0x4857A5e3Cdfd91135CE509867e48C10Bf7380Dbd';
//              addr3 = '0x7214958FC29ACFAd0450C0881EB916AC172435e2';
//              addr4 = '0xE76E1fE3501328a2c81eaeb92476213dEA224184';
              //also: 0xD268CE34B2a1CD9BD9cC80e4f2d4825d498342dc ,
              //      0x4d6BF011855d8E36A54A2D04d5B5073C4E125b34
              break
            default:
              revertReasonSupported = true;
              console.log('Testing on local test env.')
          }

        console.log(`1st account: ${addr1}`);
        console.log(`2st account: ${addr2}`);
        console.log(`3st account: ${addr3}`);
        console.log(`4st account: ${addr4}`);

        await loadAllContractInstances();

          const zeroPTok = 0;

          let params_ = { tokenName: "tok332",
                          tokenSymbol: "tk4",
                          projectVault: ZERO_ADDR,
                          paymentToken: paymentTokenInstance.address,
                          minPledgedSum: MIN_PLEDGE_SUM,
                          initialTokenSupply: 100*MILLION,
                          projectToken: ZERO_ADDR,
                          cid: CID_VALUE };

          let ts_ = await platformInst.getBlockTimestamp();

          milestones_ = [
                { milestoneApprover: extApprover_2, prereqInd: -1, pTokValue: zeroPTok,        result: 0, dueDate: addSecs(ts_, 200000) },
                { milestoneApprover: extApprover_3, prereqInd: -1, pTokValue: MILESTONE_VALUE, result: 0, dueDate: addSecs(ts_, 200000) },
                { milestoneApprover: extApprover_4, prereqInd: -1, pTokValue: MILESTONE_VALUE, result: 0, dueDate: addSecs(ts_, 200000) }
          ];

          const projectAddr_ = await invokeCreateProject( params_, milestones_, addr1);

          const paymentTokenAddress = await thisProjInstance.getPaymentTokenAddress();
          assert.equal( paymentTokenInstance.address, paymentTokenAddress, "bad paymentTokenAddress");

          await verifyMinPledgeSum();

          await verifyProjectMayNotBeReinitialized( milestones_);

//          let projectVaultAddr_ = await thisProjInstance.getVaultAddress();
          let projectVaultAddr_ = await platformInst.globalVault();
          console.log(`==> projectVaultAddr_: ${projectVaultAddr_}`);
          thisVaultInstance = await Vault.at( projectVaultAddr_);

          await verifyVaultEntryForProjectExists( thisVaultInstance, projectAddr_);

          await verifyActiveProject();

          await setPaymentTokenAllowanceForProject( addr1, ALLOWANCE_TO_PROJECT);
          await setPaymentTokenAllowanceForProject( addr2, ALLOWANCE_TO_PROJECT);
          await setPaymentTokenAllowanceForProject( addr3, ALLOWANCE_TO_PROJECT);
          await setPaymentTokenAllowanceForProject( addr4, ALLOWANCE_TO_PROJECT);

          lastTeamWalletBalance = await getPaymentTokenBalance( thisTeamWallet);
   }


   async function invokeCreateProject( params_, milestones_, addr_) {
          let receipt_ = await platformInst.createProject( params_, milestones_, { from: addr_ });

          let projectAddr_ = await extractProjectAddressFromEvent( receipt_);

          // cast projectAddress_ to project instance;
          thisProjInstance = await Project.at( projectAddr_);

          thisTeamWallet = await thisProjInstance.getTeamWallet();

          return projectAddr_;
    }


   async function getPaymentTokenBalance( addr_) {
          return await paymentTokenInstance.balanceOf( addr_);
   }

    async function mintPaymentTokenToAddress(  addr_) {
           let pre_balance = await getPaymentTokenBalance( addr_);

           await paymentTokenInstance.mint( addr_, INITIAL_PLEDGER_PAYMENT_TOKEN_ALLOCATION);

           let post_balance = await getPaymentTokenBalance( addr_);

           let actualDiff = post_balance.sub( new BN(pre_balance));

           assert.equal( actualDiff.toString(), INITIAL_PLEDGER_PAYMENT_TOKEN_ALLOCATION, "bad pledgerTokenAmount");
    }


   function addSecs(baseSecs, addedSecs) {
        return (new BN(baseSecs).add(new BN(addedSecs))).toString();
   }

   let extApprover_2 = { externalApprover: addr2, targetNumPledgers: 0, fundingPTokTarget: 0 };
   let extApprover_3 = { externalApprover: addr3, targetNumPledgers: 0, fundingPTokTarget: 0 };
   let extApprover_4 = { externalApprover: addr4, targetNumPledgers: 0, fundingPTokTarget: 0 };


   async function printProjectParams() {
        let owner_ = await thisProjInstance.getOwner();
        let team_ = await thisProjInstance.getTeamWallet();
        let start_ = await thisProjInstance.getProjectStartTime();
        let curState_ = await thisProjInstance.getProjectState();

        console.log("");
        console.log(`proj owner: ${owner_}`);
        console.log(`proj team: ${team_}`);
        console.log(`proj start: ${start_}`);
        console.log(`proj curState_: ${curState_}`);
        console.log("");
    }


    async function verifyMilestoneIsNotOverdue( ind) {
        try {
            await thisProjInstance.onMilestoneOverdue(ind);
            assert.fail( "milestone should not be overdue");
         } catch(err) {
            logExpectedError(err);
         }
    }


    async function verifyIncorrectApproverCannotApprove( ind, approverAddr) {
        try {
            await thisProjInstance.onExternalApproverResolve( ind, true, 'bla bla', {from: approverAddr});
            assert.fail( withErr, "Incorrect milestone approver");
         } catch(err) {
            logExpectedError(err);
         }
   }

   async function verifyHasFailureRecord() {
        let onFailureParams = await thisProjInstance.getOnFailureParams();
        assert.isTrue( onFailureParams[0], "no failureRecord");
   }

   async function verifyNoFailureRecord() {
        let onFailureParams = await thisProjInstance.getOnFailureParams();
        assert.isFalse( onFailureParams[0], "has failureRecord");
   }

   async function verifyMilestoneResult( ind, expectedResult) {
        let actualResult = await thisProjInstance.getMilestoneResult(ind);
        assert.equal( actualResult, expectedResult, "bad milestone result");
   }

   async function setMilestoneResultToSuccessAndVerifyFailure( ind, approverAddr) {
        await verifyMilestoneResult( ind, MILESTONE_UNRESOLVED);

        await verifyActiveProject();

        let pre_vaultBalance = await thisProjInstance.getVaultBalance();

        await thisProjInstance.onExternalApproverResolve( ind, true, 'bla bla', { from: approverAddr });

        let post_vaultBalance = await thisProjInstance.getVaultBalance();

        if (PROJECT_FAILED == await thisProjInstance.getProjectState()) {
            await verifyFailedProject( -1);
            assert.equal( post_vaultBalance.toString(), pre_vaultBalance.toString(), "vault balance should not pass to team wallet on failure");
            await verifyMilestoneResult( ind, MILESTONE_FAILED);
            await verifyVaultBalanceEquals( pre_vaultBalance);
            return false;
        }

        assert.fail("approval must result in failure");
   }


   async function setMilestoneResult( ind, succeeded, approverAddr) {
        await verifyMilestoneResult( ind, MILESTONE_UNRESOLVED);

        let milestoneValue = await getMilestoneValue( ind);

        let pre_vaultBalance = await thisProjInstance.getVaultBalance();

        await verifyActiveProject();

        let ptokAddr_ = await thisProjInstance.paymentTokenAddress();
        console.log(`===>  ptokAddr_: ${ptokAddr_}`);

        let ptokBalance_ = await thisProjInstance.getVaultBalance();
        console.log(`===>  ptokBalance_: ${ptokBalance_}`);

        await thisProjInstance.onExternalApproverResolve( ind, succeeded, 'bla bla', { from: approverAddr });

        let post_vaultBalance = await thisProjInstance.getVaultBalance();

        // below must be called after each onExternalApproverResolve() to verify not failed due to milestone overdue
        if (PROJECT_FAILED == await thisProjInstance.getProjectState()) {
            await verifyFailedProject( -1);
            assert.equal( post_vaultBalance.toString(), pre_vaultBalance.toString(), "vault balance should remain unchanged");
            await verifyMilestoneResult( ind, MILESTONE_FAILED);
            await verifyVaultBalanceEquals( pre_vaultBalance);
            return false;
        }

        if (succeeded) {
            // milestoneValue moved from vault to team wallet
            let expectedVaultBalance = pre_vaultBalance.sub(milestoneValue);

            const projectState = await thisProjInstance.getProjectState();
            if (projectState == PROJECT_SUCCEEDED) {
                await verifySuccessfulProject();
                // upon successful project completion all funds are transferred to team wallet
                expectedVaultBalance = 0;
            }

            assert.equal( post_vaultBalance.toString(), expectedVaultBalance.toString(), "milestone sum not added to vault balance");
            await verifyMilestoneResult( ind, MILESTONE_SUCCEEDED);

        } else {
            assert.equal( post_vaultBalance.toString(), pre_vaultBalance.toString(), "vault balance should remain unchanged");
            await verifyMilestoneResult( ind, MILESTONE_FAILED);
            await verifyFailedProject( -1);
        }

        return succeeded;
    }


    async function verifyMilestoneApprovalFailsIfInsufficientFundsInVault( ind, approverAddr) {
        await verifyActiveProject();
        try {
             await thisProjInstance.onExternalApproverResolve( ind, true, 'bla bla', {from: approverAddr});
             assert.fail( "milestone approval failed: insufficient funds in vault");
         } catch(err) {
            logExpectedError(err);
         }
     }

     async function verifyNumPledgers( num) {
         let numPledgers = await thisProjInstance.numPledgersSofar();
         assert.equal( numPledgers, num, "bad numPledgers");
      }

     async function printVaultBalance() {
         let balance = await thisProjInstance.getVaultBalance();
         const pTokValue = Web3.utils.fromWei( balance, COIN_UNIT);
         console.log("");
         console.log(`===>  Vault balance in payment tokens : ${pTokValue}`);
     }

     async function printTeamWalletChanges() {
         let curr_balanceInWei = await getPaymentTokenBalance( thisTeamWallet);
         let curr_balance = web3.utils.toBN( curr_balanceInWei);

         if (curr_balance < lastTeamWalletBalance) {
             //should not happen
             assert.fail("curr_balance < lastTeamWalletBalance");

             let diff = new BN(lastTeamWalletBalance).sub(new BN(curr_balance));
             const pTokValue = Web3.utils.fromWei( diff.toString(), COIN_UNIT);
             console.log("");
             console.log(`===>  gas costs reduced from Team Wallet: ${pTokValue} `);
             console.log("");

         } else {
             let diff = curr_balance.sub( new BN(lastTeamWalletBalance));
             const pTokValue = Web3.utils.fromWei( diff, COIN_UNIT);
             console.log("");
             console.log(`===>  payment tokens added to Team Wallet: ${pTokValue} PToks`);
             console.log("");
         }

         lastTeamWalletBalance = curr_balance;
      }


     async function getPrintableTeamWalletTotal() {
         let curr_balanceInWei = await getPaymentTokenBalance( thisTeamWallet);
         let curr_balance = web3.utils.toBN( curr_balanceInWei);
         return Web3.utils.fromWei( curr_balance.toString(), COIN_UNIT);
     }

     async function printTeamWalletTotal( initTeamWallet) {
         let curr_balanceInWei = await getPaymentTokenBalance( thisTeamWallet);
         let pTokValue = await getPrintableTeamWalletTotal();
         console.log("");
         console.log(`  Current Team Wallet payment token balance: ${pTokValue} PToks`);
         console.log(`  Initial Team Wallet payment token balance: ${initTeamWallet} PToks`);

         lastTeamWalletBalance = curr_balanceInWei;
      }


      async function issueNewPledge( pledgeSumWei, pledgerAddr) {

         const pre_vaultBalance = await thisProjInstance.getVaultBalance();
         const pre_pledgerBalance = await getPaymentTokenBalance( pledgerAddr);

         const pre_NumPledgers = (await thisProjInstance.numPledgersSofar()).toNumber();
         const pre_NumEvents = (await thisProjInstance.getNumEventsForPledger(pledgerAddr)).toNumber();


         await verifyAllowanceCoversPledgedSum( pledgeSumWei, pledgerAddr);

         await thisProjInstance.minPledgedSum();

         const minPledgedSum_ = await thisProjInstance.minPledgedSum();

         const gteMinSum = new BN(pledgeSumWei).gte( new BN(minPledgedSum_));
         if (!gteMinSum) {
            console.log(`+++gteMinSum failed:  pledgeSumWei = ${pledgeSumWei}, minPledgedSum_ = ${minPledgedSum_} `);
         }
         assert.isTrue( gteMinSum, "pledgeSumWei < minPledgedSum_");

         let receipt = await invokeNewPledge( pledgeSumWei, pledgerAddr );

         expectEvent( receipt, 'NewPledgeEvent', { pledger: pledgerAddr, sum: pledgeSumWei });


         const post_NumEvents = await thisProjInstance.getNumEventsForPledger(pledgerAddr);

         assert.equal( pre_NumEvents+1, post_NumEvents, "failed to add pledger");

         const post_NumPledgers = await thisProjInstance.numPledgersSofar();

         const post_vaultBalance = await thisProjInstance.getVaultBalance();
         const post_pledgerBalance = await getPaymentTokenBalance( pledgerAddr);

         const expected_vaultBalance = pre_vaultBalance.add( new BN(pledgeSumWei));
         const expected_pledgerBalance = pre_pledgerBalance.sub( new BN(pledgeSumWei));

         assert.equal( post_vaultBalance.toString(), expected_vaultBalance.toString(), "incorrect vault balance");
         assert.equal( post_pledgerBalance.toString(), expected_pledgerBalance.toString(), "incorrect pledger balance");

         console.log(`add to vault : pre_vaultBalance : ${pre_vaultBalance} ,  pre_vaultBalance: ${pre_vaultBalance} , pledgeSumWei = ${pledgeSumWei} `);

         if (pre_NumEvents == 0) {
            assert.equal( pre_NumPledgers+1, post_NumPledgers, "pledger successfully added");
         } else {
             assert.equal( pre_NumPledgers, post_NumPledgers, "event successfully added to pledger");
         }

         return new BN(pledgeSumWei);
    }


   async function invokeNewPledge( pledgedSum_, pledgerAddr) {
        await verifyAboveMinPledgeSum( pledgedSum_);
        await verifyAllowanceCoversPledgedSum( pledgedSum_, pledgerAddr);
        return thisProjInstance.newPledge(  pledgedSum_, paymentTokenInstance.address, { from: pledgerAddr });
   }


   async function verifyAboveMinPledgeSum( pledgedSum_) {
        let minPledgedSum_ = await thisProjInstance.minPledgedSum();
        const aboveMin = new BN(pledgedSum_).gte( new BN(minPledgedSum_));
        if (!aboveMin) {
            console.log( `aboveMin pledgedSum_ : ${pledgedSum_} ,  minPledgedSum_: ${minPledgedSum_}  `);
        }
        assert.isTrue( aboveMin, "pledgedSum_ < min");
    }



   ////////////////

   async function verifyVaultEntryForProjectExists( thisVaultInstance, projectAddr_) {
       let exists = await thisVaultInstance.projectEntryExists( projectAddr_);
       assert.isTrue( exists, "vault: no proj entry");
   }


   async function verifyProjectMayNotBeReinitialized( milestones_) {
          let projectInitParams = {
                       projectTeamWallet: addr1,
                       vault: addr1,
                       milestones: milestones_,
                       projectToken: addr1,
                       platformCutPromils: 100,
                       minPledgedSum: 1000000,
                       onChangeExitGracePeriod: 100000,
                       pledgerGraceExitWaitTime: 10000,
                       paymentToken: paymentTokenInstance.address,
                       cid: CID_VALUE
          };

          if ( !revertReasonSupported) {
              await expectRevert.unspecified(
                   thisProjInstance.initialize( projectInitParams)
              );

          } else {
              const expectedError = 'can only be initialized once';
              await expectRevert(
                       thisProjInstance.initialize( projectInitParams),
                       expectedError );
          }
   }

    async function verifyMilestoneNotOnchain( ind, errmsg) {
        if ( !revertReasonSupported) {
            await expectRevert.unspecified(
                  thisProjInstance.checkIfOnchainTargetWasReached(ind)
            );

        } else {
            const expectedError = 'milestone not onchain';
            await expectRevert(
                      thisProjInstance.checkIfOnchainTargetWasReached(ind),
                      expectedError );
         }
    }

   async function verifyMinPledgeSum() {
          if ( !revertReasonSupported) {
                await expectRevert.unspecified(
                     thisProjInstance.newPledge(  MIN_PLEDGE_SUM-1, paymentTokenInstance.address, { from: addr1 })
                );

          } else {
                const expectedError = "pledge must exceed min token count";
                await expectRevert(
                    thisProjInstance.newPledge(  MIN_PLEDGE_SUM-1, paymentTokenInstance.address, { from: addr1 }),
                    expectedError );
           }
   }

    async function verifyMilestoneIndexIsOOB( ind) {
            await expectRevert.unspecified(
                            thisProjInstance.checkIfOnchainTargetWasReached(ind));
    }


   async function extractRefundSumFromFailureEvent( receipt_) {
        let actuallyRefunded_ = -1;
        truffleAssert.eventEmitted( receipt_, 'ProjectFailurePledgerRefund', (ev) => {
            actuallyRefunded_ = ev.actuallyRefunded;
            return true;
        });
        return actuallyRefunded_;
   }

   async function extractRefundSumFromGracePeriodEvent( receipt_) {
        let shouldBeRefunded_ = -1;
        let actuallyRefunded_ = -1;
        truffleAssert.eventEmitted( receipt_, 'GracePeriodPledgerRefund', (ev) => {
            shouldBeRefunded_ = ev.shouldBeRefunded;
            actuallyRefunded_ = ev.actuallyRefunded;
            return true;
        });
        return [shouldBeRefunded_, actuallyRefunded_];
   }


   async function extractProjectAddressFromEvent( receipt_) {
        let projectAddr_ = ZERO_ADDR;
        truffleAssert.eventEmitted( receipt_, 'ProjectWasDeployed', (ev) => {
            projectAddr_ = ev.projectAddress;
            return true;
        });
        console.log(`project address: ${projectAddr_}`);
        return projectAddr_;
   }

    //////////////////


    async function verifyAllowanceCoversPledgedSum( sum_, pledgerAddr) {
         // pledger must set payment-token allowance to the project
         let spender = thisProjInstance.address;

         let totalApprovedSum_ = await paymentTokenInstance.allowance( pledgerAddr, spender);

         const allowanceIsFine = new BN(totalApprovedSum_).gte( new BN(sum_));
         if (allowanceIsFine) {
             console.log( `sum_ : ${sum_} ,  totalApprovedSum_: ${totalApprovedSum_}  `);
         } else {
            console.log( `==bad allowance== sum_ : ${sum_} ,  totalApprovedSum_: ${totalApprovedSum_}  `);
         }
         assert.isTrue( allowanceIsFine, "approval failed");
    }


    async function setPaymentTokenAllowanceForProject( pledgerAddr, requestedAllowance) {

         let spender = thisProjInstance.address;

         await paymentTokenInstance.approve( spender, requestedAllowance, { from: pledgerAddr });

         const actualAllowance = await paymentTokenInstance.allowance( pledgerAddr, spender);

         console.log(`actualAllowance : ${actualAllowance} ,  requestedAllowance : ${requestedAllowance}, pledgerAddr: ${pledgerAddr}  , spender: ${spender} `);
         assert.isTrue( actualAllowance == requestedAllowance, "allowance failed");
    }


    async function verifyNumEventsForPledger( pledgerAddr, expectedNumEvents) {
         let pledgerNumEvents = await thisProjInstance.getNumEventsForPledger( pledgerAddr);
         assert.equal( pledgerNumEvents, expectedNumEvents, "bad NumEvents");
    }

    async function verifyPledgeEventValueInPTok( pledgerAddr, eventIndex, expectedValueWei) {
        let pledgeEvent = await thisProjInstance.getPledgeEvent( pledgerAddr, eventIndex);
        const printableValuePTok = Web3.utils.fromWei( pledgeEvent[1], COIN_UNIT);

        assert.equal( expectedValueWei, pledgeEvent[1],  "bad pledge-event value");
    }


    async function verifyVaultBalanceEquals( expected_vaultBalance) {
        let curr_vaultBalance = await thisProjInstance.getVaultBalance();
        console.log(`Vault balance in payment tokens: ${curr_vaultBalance}`);

        assert.equal( curr_vaultBalance.toString(), expected_vaultBalance.toString(), "incorrect vault balance");
    }

  async function printCurrentBlockTimestamp() {
      let timestamp_ = await platformInst.getBlockTimestamp();
      console.log(`current block timestamp: ${timestamp_}`);
  }

  async function printMilestoneOverdueTime(ind) {
       let dueTime = await thisProjInstance.getMilestoneOverdueTime( ind);
       console.log(`milestone ${ind} overdue time: ${dueTime}`);
  }

  async function verifyMilestoneIsOverdue( ind, expectedOverdue) {
       let isOverdue = await thisProjInstance.milestoneIsOverdue( ind);
       assert.equal( isOverdue, expectedOverdue, "verifyMilestoneIsOverdue failed");
  }

  async function verifyPledgerCannotExitProject( pledgerAddr) {
        try {
            await thisProjInstance.onGracePeriodPledgerRefund({ from: pledgerAddr});
            assert.fail( "onGracePeriodPledgerRefund should fail");
         } catch(err) {
            logExpectedError(err);
         }
  }

  async function verifyPledgerCanExitWhileInGracePeriod( pledgerAddr) {

        let isPledger = await thisProjInstance.isActivePledger( pledgerAddr);
        assert.isTrue( isPledger, "not a pledger");

        const pre_pledgerBalance = await getPaymentTokenBalance( pledgerAddr);

        const pre_numPledgers = await thisProjInstance.numPledgersSofar();

        let receipt = await thisProjInstance.onGracePeriodPledgerRefund({ from: pledgerAddr});

        let resArr_ = await extractRefundSumFromGracePeriodEvent( receipt);
        const shouldBeRefunded_ = resArr_[0];
        const actuallyRefunded_ = resArr_[1];

        const post_pledgerBalance = await getPaymentTokenBalance( pledgerAddr);

        console.log(`++++balance pre_pledgerBalance: ${pre_pledgerBalance}, shouldBeRefunded_ ${shouldBeRefunded_} ,
                        actuallyRefunded_ ${actuallyRefunded_} , post_pledgerBalance ${post_pledgerBalance} `);

        // verify pledger removed
        const post_numPledgers = await thisProjInstance.numPledgersSofar();
        const expected_numPledgers = pre_numPledgers.sub( new BN(1));
        assert.equal( post_numPledgers.toNumber(), expected_numPledgers.toNumber(), "numPledgers not decreased");

        isPledger = await thisProjInstance.isActivePledger( pledgerAddr);
        assert.isFalse( isPledger, "still a pledger");

        // verify project still in progress
        await verifyActiveProject();

        // verify PTok deposit returned to pledger:
        const expected_pledgerBalance = new BN(pre_pledgerBalance).add( new BN(actuallyRefunded_));

        verifyEqualValues( post_pledgerBalance, expected_pledgerBalance, "bad post pledge balance");
  }

  async function setMilestoneResultToSuccess( ind_, addr_) {
        const pre_teamBalance = await getPaymentTokenBalance( thisTeamWallet);

        await setMilestoneResult( ind_, true, addr_);

        const milestoneValue_ = await getMilestoneValue( 0);

        const post_teamBalance = await getPaymentTokenBalance( thisTeamWallet);

        verifyLeftApproxEqualsSum( post_teamBalance, pre_teamBalance, milestoneValue_);
  }

  async function executeProjectWithLatePledgers() {

        const initPrintableTeamWallet = await getPrintableTeamWalletTotal();

        const teamBalance_0 = await getPaymentTokenBalance( thisTeamWallet);

        await addAllPledgers(); // addr3 + addr4

        await setMilestoneResultToSuccess( 0, addr2);

        await verifyActiveProject();

        await verifyPledgerCannotExitProject( addr2);
        await verifyPledgerCannotExitProject( addr3);
        await verifyPledgerCannotExitProject( addr4);

        await printTeamWalletChanges();

        await verifyMilestoneResult( 1, MILESTONE_UNRESOLVED);
        await verifyMilestoneResult( 2, MILESTONE_UNRESOLVED);

        // add pledger after first milestone approve
        const additionalPledgeSum = await addSinglePledger( addr2, 2);

        await verifyPledgerCannotExitProject( addr2);

        const teamBalance_4 = await getPaymentTokenBalance( thisTeamWallet);
        const milestoneValue_2 = await getMilestoneValue( 2);

        await setMilestoneResult( 2, true, addr4);

        const teamBalance_5 = await getPaymentTokenBalance( thisTeamWallet);
        verifyLeftApproxEqualsSum( teamBalance_5, teamBalance_4, milestoneValue_2);


        await printTeamWalletChanges();

        await verifyActiveProject();

        const teamBalance_6 = await getPaymentTokenBalance( thisTeamWallet);

        const milestoneValue_1 = await getMilestoneValue( 1);

        await setMilestoneResult( 1, true, addr3);

        const teamBalance_7 = await getPaymentTokenBalance( thisTeamWallet);

        //do not run test below here - after project successful end ALL vault funds are moved to team wallet
        //----verifyLeftApproxEqualsSum( teamBalance_7, teamBalance_6, milestoneValue_1);

        await actOnSuccessfulProject( true);

        await printVaultBalance();

        await printTeamWalletTotal( initPrintableTeamWallet);
  }



  function verifyLeftApproxEqualsSum( leftVal, rightVal_1, rightVal_2) {
        // approx. because some promils goes to platform
        let rightSum = new BN(rightVal_1).add( new BN( rightVal_2));

        var rightSum90Prcnt = rightSum.mul( new BN(98)).div(new BN(100));
        const equal_ =  leftVal.gte( rightSum90Prcnt) && rightSum.gte(leftVal);

        assert.isTrue( equal_, "verifyLeftApproxEqualsSum failed");
  }

  function verifyLeftEqualsSum( leftVal, rightVal_1, rightVal_2) {
        let rightSum = new BN(rightVal_1).add( new BN( rightVal_2));
        let equals_ = new BN(leftVal).eq( rightSum);
        if ( !equals_) {
            console.log(`++++verifyLeftEqualsSum:  leftVal = ${leftVal}, rightVal_1 = ${rightVal_1} , rightVal_2 = ${rightVal_2} `);
        }
        assert.isTrue( equals_, "verifyLeftEqualsSum failed");
  }


  async function getMilestoneValue( ind_) {
    return await thisProjInstance.getMilestoneValueInPaymentTokens( ind_);
  }


  async function executeProjectWithGracePeriod() {

        await addAllPledgers(); // addr3 + addr4

        let addr3_balance_1 = await getPaymentTokenBalance( addr3);
        console.log(`++++balance init balance ${addr3_balance_1}  `);

        let pre_graceEndDate = await thisProjInstance.getEndOfGracePeriod();
        assert.equal( pre_graceEndDate.toNumber(), 0, "graceEndDate not zero");

        await verifyPledgerCannotExitProject( addr3);

        // change contract results in entering grace period
        let receipt = await thisProjInstance.updateProjectDetails( milestones_, MIN_PLEDGE_SUM);
        expectEvent( receipt, 'ProjectDetailedWereChanged');

        await verifyActiveProject();

        // verify grace period was entered
        let post_graceEndDate = await thisProjInstance.getEndOfGracePeriod();
        let timestamp = await platformInst.getBlockTimestamp();

        assert.isAbove( post_graceEndDate.toNumber(), timestamp.toNumber(), "graceEndDate not changed");

        // have addr3 exit project
        receipt = await thisProjInstance.setPledgerWaitTimeBeforeGraceExit(0); // avoid refusal due to late pledger entry
        expectEvent( receipt, 'PledgerGraceExitWaitTimeChanged', { newValue: '0' });

        await verifyPaymentTokenBalance( addr3, addr3_balance_1);

        await verifyPledgerCanExitWhileInGracePeriod( addr3);

        const EXIT_WAIT_TiME = 36000;
        receipt = await thisProjInstance.setPledgerWaitTimeBeforeGraceExit( EXIT_WAIT_TiME);
        expectEvent( receipt, 'PledgerGraceExitWaitTimeChanged', { newValue: ''+EXIT_WAIT_TiME });

        // make sure exited pledger can re-enter
        await issueNewPledge( PLEDGE_SUM_1, addr3);

        await verifyActiveProject();
  }


  async function verifyPaymentTokenBalance( addr_, expected_) {
        let actual_ = await getPaymentTokenBalance( addr_);
        let match_ = actual_.toString() == expected_.toString();
        if ( !match_) {
            console.log(`++++balance expected_: ${expected_}, actual_: ${actual_}  `);
        }
        assert.isTrue( match_, "bad balance");
  }

  async function executeProjectWithOverdueMilestone() {

        const milestoneInd_ = 2;

        await addAllPledgers(); // addr3 + addr4

        await verifyMilestoneResult( milestoneInd_, MILESTONE_UNRESOLVED);
        await verifyMilestoneIsOverdue( milestoneInd_, false);

        await verifyActiveProject();

        await thisProjInstance.backdoor_markMilestoneAsOverdue( milestoneInd_);

        await verifyMilestoneIsOverdue( milestoneInd_, true);
        await verifyMilestoneResult( milestoneInd_, MILESTONE_UNRESOLVED);

        // attempt to approve an overdue milestone should result in project failing
        await setMilestoneResultToSuccessAndVerifyFailure( milestoneInd_, addr4);

        await actOnFailedProject( -1);
  }



  async function addSinglePledger(addrToAdd, numPledgersSofar) {

      await verifyNumPledgers( numPledgersSofar);

      const teamBalance_0 = await getPaymentTokenBalance( thisTeamWallet);
      const vaultBalance_0 = await thisProjInstance.getVaultBalance();

      let pledge_1 = await issueNewPledge( PLEDGE_SUM_2, addrToAdd);

      const teamBalance_1 = await getPaymentTokenBalance( thisTeamWallet);
      const vaultBalance_1 = await thisProjInstance.getVaultBalance();

      verifyEqualValues( teamBalance_0, teamBalance_1, "pledge must not go directly to team");

      verifyLeftEqualsSum( vaultBalance_1, vaultBalance_0, PLEDGE_SUM_2);


      await verifyPledgeEventValueInPTok( addrToAdd, 0, PLEDGE_SUM_2);

      await verifyNumPledgers( numPledgersSofar+1);

      await verifyNumEventsForPledger( addrToAdd, 1);

      await printVaultBalance();

      const teamBalance_2 = await getPaymentTokenBalance( thisTeamWallet);
      const vaultBalance_2 = await thisProjInstance.getVaultBalance();

      let pledge_2 = await issueNewPledge( PLEDGE_SUM_3, addrToAdd);

      const teamBalance_3 = await getPaymentTokenBalance( thisTeamWallet);
      const vaultBalance_3 = await thisProjInstance.getVaultBalance();

      verifyEqualValues( teamBalance_3, teamBalance_2, "pledge must not go directly to team /2");

      verifyLeftEqualsSum( vaultBalance_3, vaultBalance_2, PLEDGE_SUM_3);

      await verifyNumEventsForPledger( addrToAdd, 2);

      await verifyPledgeEventValueInPTok( addrToAdd, 1, PLEDGE_SUM_3);


      const teamBalance_4 = await getPaymentTokenBalance( thisTeamWallet);
      const vaultBalance_4 = await thisProjInstance.getVaultBalance();

      let pledge_3 = await issueNewPledge( PLEDGE_SUM_4, addrToAdd);

      const teamBalance_5 = await getPaymentTokenBalance( thisTeamWallet);
      const vaultBalance_5 = await thisProjInstance.getVaultBalance();

      verifyEqualValues( teamBalance_5, teamBalance_4, "pledge must not go directly to team /3");

      verifyLeftEqualsSum( vaultBalance_5, vaultBalance_4, PLEDGE_SUM_4);

      await verifyPledgeEventValueInPTok( addrToAdd, 2, PLEDGE_SUM_4);

      await verifyNumEventsForPledger( addrToAdd, 3);

      await verifyNumPledgers( numPledgersSofar+1); // should remain the same

  }


  function verifyEqualValues( val1, val2,errmsg) {
      assert.equal( val1.toString(), val2.toString(), errmsg);
  }


  async function addAllPledgers() {
      await verifyNumPledgers(0);

      const initBalance_ = await getPaymentTokenBalance( addr3);

      await issueNewPledge( PLEDGE_SUM_4, addr3);

      let expected_balance_1 = new BN( initBalance_).sub( new BN( PLEDGE_SUM_4));
      await verifyPaymentTokenBalance( addr3, expected_balance_1);

      await verifyPledgeEventValueInPTok( addr3, 0, PLEDGE_SUM_4);

      await verifyNumPledgers(1);

      await verifyNumEventsForPledger( addr1, 0);

      await verifyNumEventsForPledger( addr2, 0);

      await verifyNumEventsForPledger( addr3, 1);

      await printVaultBalance();

      await issueNewPledge( PLEDGE_SUM_5, addr3);

      let expected_balance_2 = expected_balance_1.sub( new BN( PLEDGE_SUM_5));
      await verifyPaymentTokenBalance( addr3, expected_balance_2);

      await verifyPledgeEventValueInPTok( addr3, 1, PLEDGE_SUM_5);

      await verifyNumPledgers(1);

      await verifyNumEventsForPledger( addr4, 0);

      await issueNewPledge( PLEDGE_SUM_4, addr4);

      await verifyNumEventsForPledger( addr4, 1);
      await verifyNumPledgers(2);

      await verifyPledgeEventValueInPTok( addr4, 0, PLEDGE_SUM_4);
  }

  async function createMultiMilestoneProject( largeMilestoneCount) {
        const zeroPTok = 0;

        let params_ = { tokenName: "tok332",
                        tokenSymbol: "tk4",
                        projectVault: ZERO_ADDR,
                        paymentToken: paymentTokenInstance.address,
                        minPledgedSum: MIN_PLEDGE_SUM,
                        initialTokenSupply: 100*MILLION,
                        projectToken: ZERO_ADDR,
                        cid: CID_VALUE };

        let ts_ = await platformInst.getBlockTimestamp();

        let milestones_ = [];

        //await platformInst.setMilestoneMinMaxCounts( 1, largeMilestoneCount+1);

        for (let i = 0; i < largeMilestoneCount; i++) {
              milestones_[i] =
                { milestoneApprover: extApprover_2, prereqInd: -1, pTokValue: zeroPTok, result: 0, dueDate: addSecs(ts_, 200000) }
        }

        const projectAddr_ = await invokeCreateProject( params_, milestones_, addr1);

        const paymentTokenAddress = await thisProjInstance.getPaymentTokenAddress();
        assert.equal( paymentTokenInstance.address, paymentTokenAddress, "bad paymentTokenAddress");

        const actualNumMilestones_ = await thisProjInstance.getNumberOfMilestones();

        assert.equal( actualNumMilestones_, largeMilestoneCount, "bad milestone count");

        await verifyMinPledgeSum();

        await verifyProjectMayNotBeReinitialized( milestones_);
   }


   async function executeProjectLifecycle( projectShouldSucceed) {

        let initTeamWalletBalance = await getPrintableTeamWalletTotal();

        await printProjectParams();

        await verifyMilestoneNotOnchain( 0);

        await verifyMilestoneIsNotOverdue( 0);

        await verifyMilestoneIndexIsOOB( 10);

        await verifyIncorrectApproverCannotApprove( 0, addr3);
        await verifyIncorrectApproverCannotApprove( 1, addr2);
        await verifyIncorrectApproverCannotApprove( 2, addr3);


        await verifyPledgerCannotBeRefundedOutsideGracePeriod( addr3);
        await verifyPledgerCannotBeRefundedOutsideGracePeriod( addr4);
        await verifyPledgerCannotBeRefundedOutsideGracePeriod( addr2); // should also fail: not a pledger

        await verifyPledgerCannotReclaimProjFailurePTok( addr3); // project not failed
        await verifyPledgerCannotReclaimProjFailurePTok( addr2); // not a pledger

        await verifyPledgerCannotObtainSuccessProjectTokens( addr3); // not successful project
        await verifyPledgerCannotObtainSuccessProjectTokens( addr2); // not a pledger


        await printTeamWalletChanges();

        let milestoneResult_;

        await setMilestoneResult( 0, true, addr2); //<==

        await printTeamWalletChanges();

        await verifyActiveProject();


        // no funds in vault
        await verifyMilestoneApprovalFailsIfInsufficientFundsInVault( 1, addr3);

        await addAllPledgers(); // addr3 + addr4

        await printVaultBalance();

        await verifyActiveProject();

        await verifyMilestoneResult( 1, MILESTONE_UNRESOLVED);
        await verifyMilestoneResult( 2, MILESTONE_UNRESOLVED);


        // approval should not assume order!

        await setMilestoneResult( 2, true, addr4);

        await printTeamWalletChanges();

        await verifyActiveProject();

        if (projectShouldSucceed) {
            await setMilestoneResult( 1, true, addr3);
            await actOnSuccessfulProject( false);

        } else {
            let pre_Balance = await thisProjInstance.getVaultBalance();

            await verifyIncorrectApproverCannotApprove( 1, addr2);

            await setMilestoneResult( 1, false, addr3);

            await actOnFailedProject( pre_Balance);
        }

        await printVaultBalance();

        await printTeamWalletTotal(initTeamWalletBalance);
   }


   async function transferProjectTokensToPledgerOnProjectSuccess( pledgerAddr) {

         let projectTokenAddr =  await thisProjInstance.getProjectTokenAddress();

         let projectTokenInstance = await BasicERC20.at( projectTokenAddr);

         let receipt = await thisProjInstance.transferProjectTokensToPledgerOnProjectSuccess({from: pledgerAddr});
         expectEvent( receipt, 'TransferProjectTokensToPledgerOnProjectSuccess', { pledger: pledgerAddr });
   }


   async function actOnFailedProject( pre_Balance) {
         await verifyFailedProject( pre_Balance);

         let vaultBalance = await thisProjInstance.getVaultBalance();
         console.log(`aaaa pre ${vaultBalance} `);

         // proj now failed- pledgers may sak for PTok refund from what remains in Vault
         onProjectFailurePledgerRefund( addr4);

         vaultBalance = await thisProjInstance.getVaultBalance();
         console.log(`after addr4: ${vaultBalance} `);

         onProjectFailurePledgerRefund( addr3);

         vaultBalance = await thisProjInstance.getVaultBalance();
         console.log(`aaaa after addr3: ${vaultBalance} `);

         await verifyPledgerCannotReclaimProjFailurePTok( addr2); // not a pledger
   }


   async function onProjectFailurePledgerRefund( pledgerAddr_) {
        const pre_balance = await getPaymentTokenBalance( pledgerAddr_);
        const receipt = await thisProjInstance.onProjectFailurePledgerRefund( { from: pledgerAddr_ } );
        let actuallyRefunded_ = await extractRefundSumFromFailureEvent( receipt);
        console.log(`onProjectFailurePledgerRefund: actually refunded sum: ${actuallyRefunded_} `);

        const post_balance = await getPaymentTokenBalance( pledgerAddr_);

        const expected_ = new BN( pre_balance).add( new BN( actuallyRefunded_));

        assert.equal( post_balance.toString(), expected_.toString(), "bad onFailure balance");
   }


   async function verifyFailedProject( pre_Balance) {
         printTeamWalletChanges();

         await verifyProjectState( PROJECT_FAILED);

         if (pre_Balance > -1) {
            await verifyVaultBalanceEquals( pre_Balance);
          }

         // project not successful - so below should fail
         verifyPledgerCannotObtainSuccessProjectTokens( addr3);
         verifyPledgerCannotObtainSuccessProjectTokens( addr4);
         verifyPledgerCannotObtainSuccessProjectTokens( addr2);

         await verifyHasFailureRecord();

         await verifyCannotAddPledgeToFinishedProject( PLEDGE_SUM_5, addr2);
    }

   async function verifyActiveProject() {
         await verifyProjectState( PROJECT_IN_PROGRESS);

         await verifyPledgerCannotReclaimProjFailurePTok( addr2);

         await verifyPledgerCannotObtainSuccessProjectTokens( addr2);

         await verifyNoFailureRecord();
    }


    async function verifySuccessfulProject() {
         await verifyProjectState( PROJECT_SUCCEEDED);

         await verifyVaultBalanceEquals( 0); // all payment tokens moved to team wallet

         await verifyAllMilestonesSucceeded();

         await verifyPledgerCannotReclaimProjFailurePTok( addr2);

         await verifyNoFailureRecord();

         await verifyCannotAddPledgeToFinishedProject( PLEDGE_SUM_5, addr2);
    }

    async function verifyAllMilestonesSucceeded() {
        const numAllMilestones = await thisProjInstance.getNumberOfMilestones();
        const numSuccessfulMilestones = await thisProjInstance.getNumberOfSuccessfulMilestones();

        assert.equal( numAllMilestones.toNumber(), numSuccessfulMilestones.toNumber(), "Successful project cannot have non-successful milestones");
    }


    async function actOnSuccessfulProject( alsoTestForAddr2) {

        await verifySuccessfulProject();

         // project successfully completed - pledgers may pull their erc20 benefits
         await transferProjectTokensToPledgerOnProjectSuccess( addr3);
         await transferProjectTokensToPledgerOnProjectSuccess( addr4);
         if (alsoTestForAddr2) {
            await transferProjectTokensToPledgerOnProjectSuccess( addr2);
         }

         // pledger cannot fetch tokens twice
         verifyPledgerCannotObtainSuccessProjectTokens( addr3);
         verifyPledgerCannotObtainSuccessProjectTokens( addr4);
         verifyPledgerCannotObtainSuccessProjectTokens( addr2);
    }


    async function verifyCannotAddPledgeToFinishedProject( pledgeSumWei, pledgerAddr) {
        try {
            await issueNewPledge( pledgeSumWei, pledgerAddr );
            assert.fail( "cannot add pledge to a finished (on success/failure) project");
         } catch(err) {
            logExpectedError(err);
         }
    }

    async function verifyPledgerCannotBeRefundedOutsideGracePeriod( pldegerddr) {
        try {
            await thisProjInstance.onGracePeriodPledgerRefund({from: pldegerddr});
            assert.fail( "should fail when not in grace");
         } catch(err) {
            logExpectedError(err);
         }
    }

    async function verifyPledgerCannotReclaimProjFailurePTok( pldegerddr) {
        try {
            await thisProjInstance.onProjectFailurePledgerRefund({from: pldegerddr});
            assert.fail( "should fail when project not failed");
         } catch(err) {
            logExpectedError(err);
         }
    }

    async function verifyPledgerCannotObtainSuccessProjectTokens( pldegerddr) {
        // due to either project not in success mode or address not of a pledger
        try {
            await thisProjInstance.transferProjectTokensToPledgerOnProjectSuccess({from: pldegerddr});
            assert.fail( "should fail when project is not successful or incorrect pledger");
         } catch(err) {
            logExpectedError(err);
         }
    }

    function logExpectedError(err) {
        console.log(`Expected error: ${err.message}`);
    }

   async function verifyProjectState( expectedState) {
        const actualState = await thisProjInstance.getProjectState();
        assert.equal( actualState, expectedState, "bad project state");
   }

   async function markProjectTeamAsBetaTester( teamAddr) {
        await platformInst.setBetaTester( teamAddr, true);
    }

});

