// SPDX-License-Identifier: MIT

pragma solidity 0.8.16;

import "../@openzeppelin/contracts/security/Pausable.sol";
import "../@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import "../@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "../@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "../@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./PledgeEvent.sol";
import "./PledgerRecord.sol";
import "./MilestoneOwner.sol";
import "../token/IMintableOwnedERC20.sol";
import "../milestone/MilestoneResult.sol";
import "../milestone/Milestone.sol";
import "../milestone/MilestoneApprover.sol";
import "../vault/IVault.sol";
import "../utils/InitializedOnce.sol";
import "./ProjectState.sol";
import "./IProject.sol";
import "./ProjectInitParams.sol";
import "../libs/Sanitizer.sol";


contract Project is IProject, MilestoneOwner, ReentrancyGuard, Pausable /*InitializedOnce*/  {

    using SafeCast for uint;


    uint public constant MAX_NUM_SINGLE_EOA_PLEDGES = 20;

    address public platformAddr;

    address public delegate;

    ProjectState public projectState = ProjectState.IN_PROGRESS;


    uint public projectStartTime; //not here! = block.timestamp;

    uint public projectEndTime;

    uint public minPledgedSum;

    IVault public projectVault;
    IMintableOwnedERC20 public projectToken;

    uint public onChangeExitGracePeriod;
    uint public pledgerGraceExitWaitTime;
    uint public platformCutPromils;

    bytes32 public metadataCID;

    uint public current_endOfGracePeriod;

    mapping (address => PledgerRecord) public pledgerMap;
    mapping (address => PledgeEvent[]) public pledgerEventMap;

    uint private pledgerMapCount ;
    uint private pledgerEventMapCount ;


    uint public numPledgersSofar;

    uint public totalNumPledgeEvents;

    OnFailureRefundParams public onFailureRefundParams;

    //---


    struct OnFailureRefundParams {
        bool exists;
        uint totalPTokInVault;
        uint totalAllPledgerPTok;
    }

    modifier openForNewPledges() {
        _requireNotPaused();
        _;
    }

    modifier onlyIfExeedsMinPledgeSum( uint numPaymentTokens_) {
        require( numPaymentTokens_ >= minPledgedSum, "pledge must exceed min token count");
        _;
    }

    modifier onlyIfSenderHasSufficientPTokBalance( uint numPaymentTokens_) {
        uint tokenBalanceOfPledger_ = IERC20( paymentTokenAddress).balanceOf( msg.sender);
        require( tokenBalanceOfPledger_ >= numPaymentTokens_, "pledger has insufficient token balance");
        _;
    }

    modifier onlyIfSenderProvidesSufficientPTokAllowance( uint numPaymentTokens_) {
        require( _paymentTokenAllowanceFromSender() >= numPaymentTokens_, "modifier: insufficient allowance");
        _;
    }

    modifier onlyIfProjectFailed() {
        require( projectState == ProjectState.FAILED, "project running");
        require( projectEndTime > 0, "bad end date"); // sanity check
        _;
    }

    modifier onlyIfProjectSucceeded() {
        require( projectState == ProjectState.SUCCEEDED, "project not succeeded");
        require( projectEndTime > 0, "bad end date"); // sanity check
        _;
    }

    modifier projectIsInGracePeriod() {
        if (block.timestamp > current_endOfGracePeriod) {
            revert PledgerGraceExitRefusedOverdue( block.timestamp, current_endOfGracePeriod);
        }
        _;
    }


    modifier onlyIfProjectCompleted() {
        require( projectState != ProjectState.IN_PROGRESS, "project not completed");
        require( projectEndTime > 0, "bad end date"); // sanity check
        _;
    }

    modifier onlyIfOwner() { // == onlyOwner
        require( msg.sender == owner, "onlyIfTeamWallet: caller is not the owner");
        _;
    }

    modifier onlyIfOwnerOrDelegate() { //@gilad
        if (msg.sender != owner && msg.sender != delegate) {
            revert OnlyOwnerOrDelegateCanPerformAction(msg.sender, owner, delegate);
        }
        _;
    }

    modifier onlyIfActivePledger() {
        require( isActivePledger(msg.sender), "not an active pledger");
        _;
    }


    modifier onlyIfPlatform() {
        require( msg.sender == platformAddr, "not platform");
        _;
    }

    //---------


    event PledgerGraceExitWaitTimeChanged( uint newValue, uint oldValue);

    event NewPledgeEvent(address pledger, uint sum);

    event GracePeriodPledgerRefund( address pledger, uint shouldBeRefunded, uint actuallyRefunded);

    event TeamWalletRenounceOwnership();

    event ProjectFailurePledgerRefund( address pledger, uint shouldBeRefunded, uint actuallyRefunded);

    event TokenOwnershipTransferredToTeamWallet( address indexed projectContract, address indexed teamWallet);

    event ProjectStateChanged( ProjectState newState, ProjectState oldState);

    event ProjectDetailedWereChanged(uint changeTime, uint endOfGracePeriod);

    event ProjectMetadataWasChanged(bytes32 newCid, bytes32 oldCid);

    event MinPledgedSumWasSet(uint newMinPledgedSum, uint oldMinPledgedSum);

    event NewPledger(address indexed addr, uint indexed numPledgersSofar, uint indexed sum_);

    event DelegateChanged(address indexed newDelegate, address indexed oldDelegate);

    event TeamWalletChanged(address newWallet, address oldWallet);

    event OnFinalPTokRefundOfPledger( address indexed pledgerAddr_, uint32 pledgerEnterTime, uint shouldBeRefunded, uint actuallyRefunded);

    event OnProjectSucceeded(address indexed projectAddress, uint endTime);

    event OnProjectFailed( address indexed projectAddress, uint endTime);

    event PledgerBenefitsWithdrawn( address indexed pledger, uint numProjectTokens);


    //---------


    error PledgeMustExceedMinValue( uint numPaymentTokens, uint minPledgedSum);

    error MaxMuberOfPedgesPerEOAWasReached( address  pledgerAddr, uint maxNumEOAPledges);

    error MissingPledgrRecord( address  addr);

    error CallerNotAPledger( address caller);

    error BadRewardType( OnSuccessReward rewardType);

    error PledgerAlreadyExist(address addr);

    error OnlyOwnerOrDelegateCanPerformAction(address msgSender, address owner, address delegate);

    error PledgerMinRequirementNotMet(address addr, uint value, uint minValue);

    error OperationCannotBeAppliedToRunningProject(ProjectState projectState);

    //error OperationCannotBeAppliedWhileFundsInVault(uint fundsInVault);

    error PledgerGraceExitRefusedOverdue( uint exitRequestTime, uint endOfGracePeriod);

    error PledgerGraceExitRefusedTooSoon( uint exitRequestTime, uint exitAllowedStartTime);

    //---------


/*
 * @title initialize()
 *
 * @dev called by the platform (= owner) to initialize a _new contract proxy instance cloned from the project template
 *
 * @event: none
 */
    function initialize( ProjectInitParams memory params_) external override  onlyIfNotInitialized { //@PUBFUNC

        _markAsInitialized( params_.projectTeamWallet);

        require( params_.paymentToken != address(0), "missing payment token");

        platformAddr = msg.sender;

        projectStartTime = block.timestamp;
        projectState = ProjectState.IN_PROGRESS;
        delegate = address(0);
        projectEndTime = 0;
        current_endOfGracePeriod = 0;
        onFailureRefundParams =  OnFailureRefundParams( false, 0, 0);
        paymentTokenAddress = params_.paymentToken;

        // make sure that template maps are empty
        require( pledgerMapCount == 0, "pledger map not empty");
        require( pledgerEventMapCount == 0, "event map not empty");


        // ..and that project counters are set to zero
        require( numPledgersSofar == 0, "numPledgersSofar == 0");
        require( totalNumPledgeEvents == 0, "totalNumPledgeEvents == 0");

        _updateProject( params_.milestones, params_.minPledgedSum);

        projectVault = params_.vault;
        projectToken = params_.projectToken;
        platformCutPromils = params_.platformCutPromils;
        onChangeExitGracePeriod = params_.onChangeExitGracePeriod;
        pledgerGraceExitWaitTime = params_.pledgerGraceExitWaitTime;
        metadataCID = params_.cid;
    }


    function getProjectStartTime() external override view returns(uint) {
        return projectStartTime;
    }

/*
 * @title setDelegate()
 *
 * @dev sets a delegate account to be used for some management actions interchangeably with the team wallet account
 *
 * @event: DelegateChanged
 */
    function setDelegate(address newDelegate) external
                            onlyIfOwner onlyIfProjectNotCompleted /* not ownerOrDelegate! */ { //@PUBFUNC
        // possibly address(0)
        address oldDelegate_ = delegate;
        delegate = newDelegate;
        emit DelegateChanged(delegate, oldDelegate_);
    }

/*
 * @title updateProjectDetails()
 *
 * @dev updating project details with milestone list and minPledgedSu, immediately entering pledger-exit grace period
 *
 * @event: ProjectDetailedWereChanged
 */ //@DOC5
    function updateProjectDetails( Milestone[] memory milestones_, uint minPledgedSum_)
                                                        external onlyIfOwnerOrDelegate onlyIfProjectNotCompleted { //@PUBFUNC
        _updateProject(milestones_, minPledgedSum_);

        // TODO > this func must not change history items: pledger list, accomplished milestones,...

        current_endOfGracePeriod = block.timestamp + onChangeExitGracePeriod;
        emit ProjectDetailedWereChanged(block.timestamp, current_endOfGracePeriod);
    }

/*
 * @title updateProjectMetadata()
 *
 * @dev updating project details with milestone list and minPledgedSu, immediately entering pledger-exit grace period
 *
 * @event: ProjectMetadataWasChanged
 */ //@DOC5
    function updateProjectMetadata(bytes32 newCid) external onlyIfOwnerOrDelegate onlyIfProjectNotCompleted {
        //@PUBFUNC
        bytes32 oldCid = metadataCID;
        metadataCID = newCid;
        emit ProjectMetadataWasChanged(newCid, oldCid);
    }

/*
 * @title setMinPledgedSum()
 *
 * @dev sets the minimal amount of payment-tokens deposit for future pledgers. No effect on existing pledgers
 *
 * @event: MinPledgedSumWasSet
 */
    function setMinPledgedSum(uint newMin) external onlyIfOwnerOrDelegate onlyIfProjectNotCompleted { //@PUBFUNC
        uint oldMin_ = minPledgedSum;
        minPledgedSum = newMin;
        emit MinPledgedSumWasSet(minPledgedSum, oldMin_);
    }

    function getOwner() public view override(IProject,InitializedOnce) returns (address) {
        return InitializedOnce.getOwner();
    }


/*
 * @title setTeamWallet()
 *
 * @dev allow  current project owner a.k.a. team wallet to change its address
 *  Internally handled by contract-ownershiptransfer= transferOwnership()
 *
 * @event: TeamWalletChanged
 */
    function setTeamWallet(address newWallet) external onlyIfOwner onlyIfProjectNotCompleted /* not ownerOrDelegate! */ { //@PUBFUNC
        changeOwnership( newWallet);
    }


    function setPledgerWaitTimeBeforeGraceExit(uint newWaitTime) external onlyIfOwner onlyIfProjectNotCompleted { //@PUBFUNC
        // will only take effect on future projects
        uint oldWaitTime_ = pledgerGraceExitWaitTime;
        pledgerGraceExitWaitTime = newWaitTime;
        emit PledgerGraceExitWaitTimeChanged( pledgerGraceExitWaitTime, oldWaitTime_);
    }

/*
 * @title renounceOwnershipOfProject()
 *
 * @dev allow  project owner = team wallet to renounce Ownership on project by setting the project's owner address to null
 *  Can only be applied for a completed project with zero internal funds
 *
 * @event: TeamWalletRenounceOwnership
 */
    function renounceOwnershipOfProject() external onlyOwner onlyIfProjectCompleted  { //@PUBFUNC
        if ( !projectIsCompleted()) {
            revert OperationCannotBeAppliedToRunningProject(projectState);
        }

        //@gilad: The _verifyVaultIsEmpty precondition for ownership renounce is now omitted.
        //  The reason: it basically allows a pledger to block this operation by not claiming his benefits
        //  this new approach has its flows, mainly that renouncing the project before all pledgers were refunded feels wrong
        //  Still, since the vault owner is the project *contract* rather than its owner, allowing ownership renounce
        //  will not result in any vault behavioral changes

        //_verifyVaultIsEmpty();


        renounceOwnership();

        emit TeamWalletRenounceOwnership();
    }


    /*
     * @title newPledge()
     *
     * @dev allow a _new pledger to enter the project
     *  This method is issued by the pledger with passed payment-token sum >= minPledgedSum
     *  Creates a pledger entry (if first time) and adds a plede event containing payment-token sum and date
     *  All incoming payment-token will be moved to project vault
     *
     *  Note: This function will NOT check for on-chain target completion (num-pledger, pledged-total)
     *         since that will require costly milestone iteration.
     *         Rather, the backend code should externally invoke the relevant onchain-milestone services:
     *           checkIfOnchainTargetWasReached() and onMilestoneOverdue()
     *         Max number of pledger events per single pledger: MAX_NUM_SINGLE_EOA_PLEDGES
     *
     * @precondition: caller (msg.sender) meeds to approve at least numPaymentTokens_ for this function to succeed
     *
     *
     * @event: NewPledger, NewPledgeEvent
     *
     * @CROSS_REENTRY_PROTECTION
     */ //@DOC2
    function newPledge(uint numPaymentTokens_, address paymentTokenAddr_)
                                        external openForAll openForNewPledges onlyIfProjectNotCompleted nonReentrant
                                        onlyIfExeedsMinPledgeSum( numPaymentTokens_)
                                        onlyIfSenderHasSufficientPTokBalance( numPaymentTokens_)
                                        onlyIfSenderProvidesSufficientPTokAllowance( numPaymentTokens_) { //@PUBFUNC //@PTokTransfer //@PLEDGER
        _verifyInitialized();

        address newPledgerAddr_ = msg.sender;

        require( paymentTokenAddr_ == paymentTokenAddress, "bad payment token");

        bool pledgerAlreadyExists = isRegisteredPledger( newPledgerAddr_);

        if (pledgerAlreadyExists) {
            verifyMaxNumPledgesNotExceeded( newPledgerAddr_);
        } else {
            _createPledgerMapRecordForSender( newPledgerAddr_);
            emit NewPledger( newPledgerAddr_, numPledgersSofar, numPaymentTokens_);
            numPledgersSofar++;
        }

        _addEventToPledgerEventMap( newPledgerAddr_, numPaymentTokens_);

        _transferPaymentTokensToVault( numPaymentTokens_);
    }


    function _createPledgerMapRecordForSender( address newPledgerAddr_) private {
        uint numCompletedMilestones_ = successfulMilestoneIndexes.length;

        PledgerRecord memory record_ = PledgerRecord({ enterDate: block.timestamp,
                                                        completedMilestonesWhenEntered: numCompletedMilestones_,
                                                        successfulMilestoneStartIndex: numCompletedMilestones_,
                                                        noLongerActive: false });
        //@gilad; pledger events stored in: pledgerEventMap[ newPledgerAddr_]

        pledgerMap[ newPledgerAddr_] = record_;
        pledgerMapCount++;
    }


    function _transferPaymentTokensToVault( uint numPaymentTokens_) private {
        address pledgerAddr_ = msg.sender;
        IERC20 paymentToken_ = IERC20( paymentTokenAddress);

        require( _paymentTokenAllowanceFromSender() >= numPaymentTokens_, "insufficient token allowance");

        projectVault.addNewPledgePToks( numPaymentTokens_);

        bool transferred_ = paymentToken_.transferFrom( pledgerAddr_, address(projectVault), numPaymentTokens_);
        require( transferred_, "Failed to transfer payment tokens to vault");
    }


    function _paymentTokenAllowanceFromSender() view private returns(uint) {
        IERC20 paymentToken_ = IERC20( paymentTokenAddress);
        return paymentToken_.allowance( msg.sender, address(this) );
    }

    function verifyMaxNumPledgesNotExceeded( address addr) private view {
        if (pledgerEventMap[addr].length >= MAX_NUM_SINGLE_EOA_PLEDGES) {
            revert MaxMuberOfPedgesPerEOAWasReached( addr, MAX_NUM_SINGLE_EOA_PLEDGES);
        }
    }


    function _addEventToPledgerEventMap( address existingPledgerAddr_, uint numPaymentTokens_) private {
        uint32 now_ = block.timestamp.toUint32();

        pledgerEventMap[ existingPledgerAddr_].push( PledgeEvent({ date: now_, sum: numPaymentTokens_ }));
        pledgerEventMapCount++;

        totalNumPledgeEvents++;

        emit NewPledgeEvent( existingPledgerAddr_, numPaymentTokens_);
    }



    function projectIsCompleted() public view returns(bool) {
        // either with success or failure
        return (projectState != ProjectState.IN_PROGRESS);
    }


    function _projectHasSucceeded() private view returns(bool) {
        // either with success or failure
        return (projectState == ProjectState.SUCCEEDED);
    }

    function projectHasFailed() external view override returns(bool) {
        return (projectState == ProjectState.FAILED);
    }


    enum OnSuccessReward { TOKENS, NFT }


    /*
     * @title transferProjectTokenOwnershipToTeam()
     *
     * @dev Allows the project team account to regain ownership on the erc20 project token after project is completed
     *  Transfer project token ownership from the project contract (= address(this)) to the team wallet
     *
     * @event: TokenOwnershipTransferredToTeamWallet
     */
    function transferProjectTokenOwnershipToTeam() external
                                                onlyIfOwner onlyIfProjectCompleted { //@PUBFUNC
        address teamWallet_ = getOwner(); // project owner is teamWallet
        address tokenOwner_ = address(this); // token owner is the project contract
        require( projectToken.getOwner() == tokenOwner_, "must be project");

        projectToken.changeOwnership( teamWallet_);

        emit TokenOwnershipTransferredToTeamWallet( tokenOwner_, teamWallet_);
    }


    /*
     * @title onProjectFailurePledgerRefund()
     *
     * @dev Refund pledger with its proportion of payment-token from team vault on failed project. Called by pledger
     * @sideeffect: remove pledger record
     *
     * @event: ProjectFailurePledgerRefund
     * @CROSS_REENTRY_PROTECTION
     */ //@DOC7
    function onProjectFailurePledgerRefund() external
                                    onlyIfActivePledger onlyIfProjectFailed
                                    nonReentrant /*pledgerWasNotRefunded*/ { //@PUBFUNC //@PLEDGER

        //@PLEDGERS_CAN_WITHDRAW_PTOK
        address pledgerAddr_ = msg.sender;

        require( onFailureRefundParams.exists, "onFailureRefundParams not set");



        // TODO >> replace below call with now commented _applyBenefitFactors impl when @INTERMEDIATE_BENEFITS_DISABLED is active
        uint shouldBeRefunded_ = _pledgerTotalPTokInvestment( pledgerAddr_);
        //uint numPToksInVaultAtTimeOfFailure_ = onFailureRefundParams.totalPTokInVault;
        //uint shouldBeRefunded_ = _applyBenefitFactors( numPToksInVaultAtTimeOfFailure_, pledgerAddr_);
        //------------------------




        uint actuallyRefunded_ = _pTokRefundToPledger( pledgerAddr_, shouldBeRefunded_, false);

        emit ProjectFailurePledgerRefund( pledgerAddr_, shouldBeRefunded_, actuallyRefunded_);

        _markPledgerAsNonActive( pledgerAddr_);

        // pledger may still receive due project-token benefits
    }


    //hhhhh will break update updateContract


    function transferProjectTokensToPledgerOnProjectSuccess() external nonReentrant onlyIfActivePledger {
        require( _projectHasSucceeded(), "project has not succeeded");
        _withdrawPledgerBenefits();
    }


    //TODO > make external when @INTERMEDIATE_BENEFITS_DISABLED active
    function _withdrawPledgerBenefits() private onlyIfActivePledger {


        // TODO >> remove to switch to periodical-benefits model @INTERMEDIATE_BENEFITS_DISABLED
        require( _projectHasSucceeded(), "project has not succeeded");
        //--------------------



        // withdraw pending project-token benefits
        address pledgerAddr_ = msg.sender;

        uint numProjectTokensToMint_ = calculatePledgerBenefits();




        // TODO >> @INTERMEDIATE_BENEFITS_DISABLED overriding numProjectTokensToMint_ so to avoid any factor calculations
        // TODO >>   instead return projectTokens in the amount of the total PTok amount invested by pledger
        numProjectTokensToMint_ = _pledgerTotalPTokInvestment( pledgerAddr_);
        //--------------------




        _mintBenefitsAndUpdateStartIndex( pledgerAddr_, numProjectTokensToMint_);

        if (projectIsCompleted()) {
            _markPledgerAsNonActive( pledgerAddr_);
        }

        emit PledgerBenefitsWithdrawn( pledgerAddr_, numProjectTokensToMint_);
    }


    function _mintBenefitsAndUpdateStartIndex( address pledgerAddr_, uint numProjectTokensToMint_) private {
        // update start index
        PledgerRecord storage pledger_ = pledgerMap[ pledgerAddr_];
        pledger_.successfulMilestoneStartIndex = successfulMilestoneIndexes.length;

        // and mint project-token benefits
        require( projectToken.getOwner() == address(this), "must be owned by project");
        projectToken.mint( pledgerAddr_, numProjectTokensToMint_);
    }


    function calculatePledgerBenefits() public view onlyIfActivePledger returns(uint) {
        // calculate unpaid benefits for all unpaid successful milestones
        address pledgerAddr_ = msg.sender;


        // TODO >> uncomment _applyBenefitFactors below once @INTERMEDIATE_BENEFITS_DISABLED is active
        return _pledgerTotalPTokInvestment( pledgerAddr_);
        //return _applyBenefitFactors( _allCompletedMilestonePToks(), pledgerAddr_);
        //---------------------------------
    }


    function _allCompletedMilestonePToks() private view returns(uint) {
        address pledgerAddr_ = msg.sender;
        uint startInd_ = _getStartIndexForPledger( pledgerAddr_);
        return _calcCompletedMilestonesSumStartingIndex( startInd_);
    }


    function _getStartIndexForPledger( address pledgerAddr_) private view returns(uint) {
        // return the completed-milestone index starting which benefits were not yet granted to pledger
        PledgerRecord storage pledger_ = pledgerMap[ pledgerAddr_];
        return pledger_.successfulMilestoneStartIndex;
    }


    function _applyBenefitFactors( uint baseSumPToks_, address pledgerAddr_) private view returns(uint) {


        // TODO >> @INTERMEDIATE_BENEFITS_DISABLED refund-factors calculation disabled
        require( false, "_applyBenefitFactors disabled for now");
        //---------




        // return (BaseSum * InvestmentFactor * TimeFactor) where:
        //      baseSumPToks_:    amount-PToks-in-vault  -or-  sum-of-all-completed-milestones
        //      InvestmentFactor: (total pledger PTok investments) / (project's total PTok investments)
        //      TimeFactor:       (num active milestones when entering) / (num all milestones)

        uint pledgerTotalPTokInvestment_ = _pledgerTotalPTokInvestment( pledgerAddr_);

        uint totalPTokInvestedInProj_ = _getTotalPToksInvestedInProject();

        uint numAllMilestones_ = getNumberOfMilestones();

        require (totalPTokInvestedInProj_ > 0 && numAllMilestones_ > 0, "zero divisor");

        uint numActiveMilestonesWhenEntering_ = _getNumActiveMilestonesWhenEntering( pledgerAddr_);

        uint sumAfterFactors_ = ( baseSumPToks_ * pledgerTotalPTokInvestment_ * numActiveMilestonesWhenEntering_ ) /
                                         ( totalPTokInvestedInProj_ * numAllMilestones_ );

        return sumAfterFactors_;
    }


    function _getNumActiveMilestonesWhenEntering( address pledgerAddr_) private view returns(uint) {
        uint numAllMilestones_ = getNumberOfMilestones();
        PledgerRecord storage pledger_ = pledgerMap[ pledgerAddr_];
        return numAllMilestones_ - pledger_.completedMilestonesWhenEntered;
    }


    function _getTotalPToksInvestedInProject() private view returns(uint) {
        return projectVault.getTotalPToksInvestedInProject();
    }


    function _calcCompletedMilestonesSumStartingIndex( uint startInd_) private view returns(uint) {
        uint pTokSum_ = 0;
        for (uint i = startInd_; i < successfulMilestoneIndexes.length; i++) {
            uint ind_ = successfulMilestoneIndexes[i];
            Milestone storage milestone_ = milestoneArr[ ind_];
            require( milestone_.result == MilestoneResult.SUCCEEDED, "milestone not successful");
            pTokSum_ += milestone_.pTokValue;
        }
        return pTokSum_;
    }


    function _pledgerTotalPTokInvestment( address pledgerAddr_) private view returns(uint) {
        PledgeEvent[] storage events = pledgerEventMap[ pledgerAddr_];
        uint total_ = 0 ;
        for (uint i = 0; i < events.length; i++) {
            total_ += events[i].sum;
        }
        return total_;
    }


    /*
     * @title onGracePeriodPledgerRefund()
     *
     * @dev called by pledger to request full payment-token refund during grace period
     *  Will only be allowed if pledger pledgerExitAllowedStartTime matches Tx time
     *  At Tx successful end the pledger record will be removed form project
     *  Note: that this service will not be available if project has completed, even if before end of grace period
     *
     * @event: GracePeriodPledgerRefund
     * @CROSS_REENTRY_PROTECTION
     */ //@DOC6
    function onGracePeriodPledgerRefund() external
                                onlyIfActivePledger projectIsInGracePeriod onlyIfProjectNotCompleted
                                nonReentrant /*pledgerWasNotRefunded*/ { //@PUBFUNC //@PLEDGER

        address pledgerAddr_ = msg.sender;

        uint pledgerEnterTime_ = getPledgerEnterTime( pledgerAddr_);

        uint pledgerExitAllowedStartTime = pledgerEnterTime_ + pledgerGraceExitWaitTime;

        if (block.timestamp < pledgerExitAllowedStartTime) {
            revert PledgerGraceExitRefusedTooSoon( block.timestamp, pledgerExitAllowedStartTime);
        }

        uint shouldBeRefunded_ = calculatePledgerBenefits();



        // TODO >> @INTERMEDIATE_BENEFITS_DISABLED remove shouldBeRefunded_ override below so to return to refund-factors calculation
        shouldBeRefunded_ = _pledgerTotalPTokInvestment( pledgerAddr_);
        //-------------




        uint actuallyRefunded_ = _pTokRefundToPledger( pledgerAddr_, shouldBeRefunded_, true);

        emit GracePeriodPledgerRefund( pledgerAddr_, shouldBeRefunded_, actuallyRefunded_);

        _markPledgerAsNonActive( pledgerAddr_);
    }


    function getBenefitCalcParams() external view returns(uint allCompletedMilestonePToks_, uint pledgerTotalPTokInvestment_,
                                                          uint totalPTokInvestedInProj_, uint numAllMilestones_,
                                                          uint numActiveMilestonesWhenEntering_, uint numCompletedMiliestones_,
                                                          uint startCompletedMilestoneInd_) {
        // a utility function to debug project-token benefit calculation
        address pledgerAddr_ = msg.sender;
        allCompletedMilestonePToks_ = _allCompletedMilestonePToks();
        pledgerTotalPTokInvestment_ = _pledgerTotalPTokInvestment(pledgerAddr_);
        totalPTokInvestedInProj_ = _getTotalPToksInvestedInProject();
        numAllMilestones_ = getNumberOfMilestones();
        numActiveMilestonesWhenEntering_ = _getNumActiveMilestonesWhenEntering( pledgerAddr_);
        numCompletedMiliestones_ = getNumberOfSuccessfulMilestones();
        startCompletedMilestoneInd_ = _getStartIndexForPledger( pledgerAddr_);
    }


    function _markPledgerAsNonActive( address pledgerAddr_) private {
        require( isActivePledger( pledgerAddr_), "not an active pledger");
        uint numPledgeEvents = pledgerEventMap[ pledgerAddr_].length;

        pledgerMap[ pledgerAddr_].noLongerActive = true;

        totalNumPledgeEvents -= numPledgeEvents;

        numPledgersSofar--;
    }


    function getNumEventsForPledger( address pledgerAddr_) external view returns(uint) {
        return pledgerEventMap[ pledgerAddr_].length;
    }

    function getPledgeEvent( address pledgerAddr_, uint eventIndex_) external view returns(uint32, uint) {
        PledgeEvent storage event_ = pledgerEventMap[ pledgerAddr_][ eventIndex_];
        return (event_.date, event_.sum);
    }

    function getPledgerEnterTime( address pledgerAddr_) private view returns(uint32) {
        return uint32(pledgerMap[ pledgerAddr_].enterDate); // pledger's enter time =  date of first pledge event
    }

    function getPaymentTokenAddress() public override view returns(address) {
        return paymentTokenAddress;
    }

    //@ITeamWalletOwner
    function getTeamWallet() external override view returns(address) {
        //return teamWallet;
        return getOwner();
    }


    function getTeamBalanceInVault() external override view returns(uint) {
        return projectVault.getTeamBalanceInVault();
    }

    function getPledgersBalanceInVault() external override view returns(uint) {
        return projectVault.vaultBalance();
    }

    function getVaultAddress() external view returns(address) {
        return address(projectVault);
    }

//--------


    function _intToUint(int intVal) private pure returns(uint) {
        require(intVal >= 0, "cannot convert to uint");
        return uint(intVal);
    }


    function _pTokRefundToPledger( address pledgerAddr_, uint shouldBeRefunded_, bool gracePeriodExit_) private returns(uint) {
        // due to project failure or grace-period exit
        uint actuallyRefunded_ = projectVault.transferPToksToPledger( pledgerAddr_, shouldBeRefunded_, gracePeriodExit_); //@PTokTransfer

        uint32 pledgerEnterTime_ = getPledgerEnterTime( pledgerAddr_);

        emit OnFinalPTokRefundOfPledger( pledgerAddr_, pledgerEnterTime_, shouldBeRefunded_, actuallyRefunded_);

        return actuallyRefunded_;
    }


    function _setProjectState( ProjectState newState_) private onlyIfProjectNotCompleted {
        ProjectState oldState_ = projectState;
        projectState = newState_;
        emit ProjectStateChanged( projectState, oldState_);
    }

    /// -----


    function getProjectTokenAddress() external view returns(address) {
        return address(projectToken);
    }

    function getProjectState() external view override returns(ProjectState) {
        return projectState;
    }

    function getProjectMetadataCID() external view returns(bytes32) {
        return metadataCID;
    }

    function _projectNotCompleted() internal override view returns(bool) {
        return projectState == ProjectState.IN_PROGRESS;
    }

    function _getProjectVault() internal override view returns(IVault) {
        return projectVault;
    }

    function getPlatformCutPromils() public override view returns(uint) {
        return platformCutPromils;
    }

    function _getPlatformAddress() internal override view returns(address) {
        return platformAddr;
    }

    function _getNumPledgersSofar() internal override view returns(uint) {
        return numPledgersSofar;
    }
    //------------


    function _onProjectSucceeded() internal override {
        _setProjectState( ProjectState.SUCCEEDED);

        _terminateGracePeriod();

        require( projectEndTime == 0, "end time already set");
        projectEndTime = block.timestamp;

        emit OnProjectSucceeded(address(this), block.timestamp);

        _transferAllVaultFundsToTeam();

        //@PLEDGERS_CAN_WITHDRAW_PROJECT_TOKENS
    }


    function getOnFailureParams() external view returns (bool,uint,uint) {
        return ( onFailureRefundParams.exists,
                 onFailureRefundParams.totalPTokInVault,
                 onFailureRefundParams.totalAllPledgerPTok);
    }


    function _onProjectFailed() internal override {
        require( _projectNotCompleted(), "project already completed");

        _setProjectState( ProjectState.FAILED);

        _terminateGracePeriod();

        projectVault.onFailureMoveTeamFundsToPledgers();

        uint totalPTokInVault_ = projectVault.vaultBalance();
        uint totalPTokInvestedInProj_ = projectVault.getTotalPToksInvestedInProject();

        //@gilad: create a refund factor that will be constant to all pledgers
        require( !onFailureRefundParams.exists, "onFailureRefundParams already set");
        onFailureRefundParams = OnFailureRefundParams({ exists: true,
                                                        totalPTokInVault: totalPTokInVault_,
                                                        totalAllPledgerPTok: totalPTokInvestedInProj_ });

        require( projectEndTime == 0, "end time already set");
        projectEndTime = block.timestamp;

        emit OnProjectFailed(address(this), block.timestamp);

        //@PLEDGERS_CAN_WITHDRAW_PTOK
    }


    function _terminateGracePeriod() private {
        current_endOfGracePeriod = 0;
    }

    function getEndOfGracePeriod() external view returns(uint) {
        return current_endOfGracePeriod;
    }


    function _transferAllVaultFundsToTeam() private {
        address platformAddr_ = _getPlatformAddress();

        (/*uint teamCut_*/, uint platformCut_) = _getProjectVault().transferAllVaultFundsToTeam( getPlatformCutPromils(), platformAddr_);

        IPlatform( platformAddr_).onReceivePaymentTokens( paymentTokenAddress, platformCut_);
    }

    function isActivePledger(address addr) public view returns(bool) {
        return isRegisteredPledger(addr) && !pledgerMap[ addr].noLongerActive;
    }

    function isRegisteredPledger(address addr) public view returns(bool) {
        return pledgerMap[ addr].enterDate > 0;
    }

    function mintProjectTokens( address to, uint numTokens) external override onlyIfPlatform { //@PUBFUNC
        projectToken.mint( to, numTokens);
    }

    //-------------- 

    function _updateProject( Milestone[] memory newMilestones, uint newMinPledgedSum) private {
        // historical records (pledger list, successfulMilestoneIndexes...) and immuables
        // (projectVault, projectToken, platformCutPromils, onChangeExitGracePeriod, pledgerGraceExitWaitTime)
        // are not to be touched here

        // gilad: avoid min/max NumMilestones validations while in update
        Sanitizer._sanitizeMilestones( newMilestones, block.timestamp, 0, 0);

        _setMilestones( newMilestones);

        delete successfulMilestoneIndexes; //@DETECT_PROJECT_SUCCESS

        minPledgedSum = newMinPledgedSum;

        //@gilad -- solve problem of correlating successfulMilestoneIndexes with _new milesones list!
    }
}
