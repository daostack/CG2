// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

struct ProjectVaultEntry {
    bool exists; // numPToks can be zero
    address pTokAddress;
    uint numPToks;
}
