// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "../@openzeppelin/contracts/utils/introspection/ERC165Storage.sol";
import "../@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./ProjectVaultEntry.sol";
import "../vault/IVault.sol";
import "../platform/IPlatform.sol";
import "../project/IProject.sol";
import "../project/PledgeEvent.sol";
import "../utils/InitializedOnce.sol";


contract CommonGoodVault is IVault, ERC165Storage, InitializedOnce {

    event PTokPlacedInVault( address project, uint sum);

    event PTokTransferredToTeamWallet( uint sumToTransfer_, address indexed teamWallet_, uint platformCut_, address indexed platformAddr_);

    event PTokTransferredToPledger( address project, uint sumToTransfer_, address indexed pledgerAddr_);

    error VaultOwnershipCannotBeTransferred( address _owner, address newOwner);

    //----

    mapping( address => ProjectVaultEntry) projectToVault; // all deposits from all pledgers


    modifier existingProject() {
        require( projectToVault[ msg.sender].exists, "no vault defined for address");
        _;
    }


    function createProjectEntry(address projectAddress_, address pTokAddress_) external override onlyOwner {
        // invokes by platform to add vault entry
        require( projectAddress_ != address(0), "no project address");
        require( pTokAddress_ != address(0), "no PTok address");
        require( !projectToVault[ projectAddress_].exists, "vault already exist");
        projectToVault[ projectAddress_] = ProjectVaultEntry({ exists: true, pTokAddress: pTokAddress_, numPToks: 0 });
    }

    function increaseBalance( uint numPaymentTokens_) external override existingProject {
        _addPToksToCaller( numPaymentTokens_);
        emit PTokPlacedInVault( msg.sender, numPaymentTokens_);
    }


    function transferPaymentTokensToPledger( address pledgerAddr_, uint numPaymentTokens_)
                                                    external override existingProject returns(uint) {
        // can only be invoked by connected project
        // @PROTECT: DoS, Re-entry

        uint actuallyRefunded_ = _transferFromVaultTo( pledgerAddr_, numPaymentTokens_);

        emit PTokTransferredToPledger( msg.sender, numPaymentTokens_, pledgerAddr_);

        return actuallyRefunded_;
    }


    function _numPToksOwnedByGlobalVault() private view existingProject returns(uint) {
        address paymentTokenAddress_ = getPaymentTokenAddress();
        return IERC20( paymentTokenAddress_).balanceOf( address(this));
    }


    function transferPaymentTokenToTeamWallet (uint totalSumToTransfer_, uint platformCut_, address platformAddr_)
                                                external override existingProject { //@PUBFUNC
        // can only be invoked by connected project
        // @PROTECT: DoS, Re-entry
        address teamWallet_ = getTeamWallet();

        require( projectToVault[ msg.sender].numPToks >= totalSumToTransfer_, "insufficient PToks in vault");
        require( _numPToksOwnedByGlobalVault() >= totalSumToTransfer_, "insufficient totalOwnedTokens");

        uint teamCut_ = totalSumToTransfer_ - platformCut_;


        // transfer from vault to team
        _transferFromVaultTo( teamWallet_, teamCut_);

        _transferFromVaultTo( platformAddr_, platformCut_);

        emit PTokTransferredToTeamWallet( teamCut_, teamWallet_, platformCut_, platformAddr_);
    }


    function _transferFromVaultTo( address receiverAddr_, uint shouldBeTransferred_) private existingProject returns(uint) {
        uint actuallyTransferred_ = shouldBeTransferred_;

        uint tokensInProjectVault_ = projectToVault[ msg.sender].numPToks;

        if (actuallyTransferred_ > tokensInProjectVault_) {
            actuallyTransferred_ = tokensInProjectVault_;
        }

        uint numPToksOwnedByGlobalVault_ = _numPToksOwnedByGlobalVault();

        if (actuallyTransferred_ > numPToksOwnedByGlobalVault_) {
            actuallyTransferred_ = numPToksOwnedByGlobalVault_;
        }

        _subtractPToksFromCaller( actuallyTransferred_);


        address paymentTokenAddress_ = getPaymentTokenAddress();

        bool transferred_ = IERC20( paymentTokenAddress_).transfer( receiverAddr_, actuallyTransferred_);
        require( transferred_, "Failed to transfer payment tokens");

        return actuallyTransferred_;
    }

    //----


    function getPaymentTokenAddress() private view existingProject returns(address) {
        return projectToVault[ msg.sender].pTokAddress;
    }

    function getTeamWallet() private view existingProject returns(address) {
        return IProject( msg.sender).getTeamWallet();
    }


    function vaultBalanceForCaller() public view override existingProject returns(uint) {
        return projectToVault[ msg.sender].numPToks;
    }

    function totalAllPledgerDepositsForCaller() public view override existingProject returns(uint) {
        return vaultBalanceForCaller();
    }

    function projectEntryExists( address project_) external override view returns(bool) {
        return projectToVault[ project_].exists;
    }

    function getOwner() public override( InitializedOnce, IVault) view returns (address) {
        return InitializedOnce.getOwner();
    }

    function changeOwnership( address newOwner) public override( InitializedOnce, IVault) {
        InitializedOnce.changeOwnership( newOwner);
    }

    function _addPToksToCaller( uint toAdd_) private {
        projectToVault[ msg.sender].numPToks += toAdd_;
    }

    function _subtractPToksFromCaller( uint toSubtract_) private {
        projectToVault[ msg.sender].numPToks -= toSubtract_;
    }



    //------ retain connected project ownership (behavior declaration)

//    function renounceOwnership() public view override existingProject {
//        require( projectToVault[msg.sender].numPToks == 0, "not empty");
//        delete projectToVault[msg.sender];
//    }

}
