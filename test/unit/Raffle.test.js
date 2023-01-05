const { inputToConfig } = require("@ethereum-waffle/compiler")
const { assert, expect } = require("chai")
const { network, getNamedAccounts, deployments, ethers } = require("hardhat")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Raffle Unit Tests", function () {
          let raffle, vrfCoordinatorV2Mock, raffleEntranceFee, deployer, interval
          const chainId = network.config.chainId

          beforeEach(async function () {
              deployer = (await getNamedAccounts()).deployer
              await deployments.fixture(["all"])
              raffle = await ethers.getContract("Raffle", deployer)
              vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer)
              raffleEntranceFee = await raffle.getEntranceFee()
              interval = await raffle.getInterval()
          })

          describe("constructor", function () {
              it("initializes the raffle correctly", async function () {
                  // ideally we make our tests have 1 assert per "it"
                  const raffleState = await raffle.getRaffleState()
                  assert.equal(raffleState.toString(), "0")
                  assert.equal(interval.toString(), networkConfig[chainId]["interval"])
              })
          })
          describe("enterRaffle", function () {
              it("reverts when you dont pay enough", async function () {
                  await expect(raffle.enterRaffle()).to.be.revertedWith(
                      "Raffle__NotEnoughETHEntered"
                  )
              })
              it("records players when they enter", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  const playerFromContract = await raffle.getPlayer(0)
                  assert.equal(playerFromContract, deployer)
              })
              it("emits event on enter", async function () {
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.emit(
                      raffle,
                      "RaffleEnter"
                  )
              })
              it("doesnt allow entrance when raffle is calculating", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  // we pretend to be chainlink keeper
                  await raffle.performUpkeep([])
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.be.revertedWith(
                      "Raffle__NotOpen"
                  )
              })
          })
          describe("checkUpkeep", function () {
              it("returns falseif people havent send any ETH", async function () {
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                  assert(!upkeepNeeded)
              })
              it("returns false if raffle isn't open", async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  await raffle.performUpkeep([]) // changes the state to calculating
                  const raffleState = await raffle.getRaffleState() // stores the new state
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x") // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
                  assert.equal(raffleState.toString() == "0", upkeepNeeded == false)
              })
              it("returns false if enough time hasn't passed", async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() - 5]) // use a higher number here if this test fails
                  await network.provider.request({ method: "evm_mine", params: [] })
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x") // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
                  assert(!upkeepNeeded)
              })
              it("returns true if enough time has passed, has players, eth, and is open", async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.request({ method: "evm_mine", params: [] })
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x") // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
                  assert(!upkeepNeeded)
              })
          })
          describe("performUpkeep", function () {
              it("it casn only run if checkUpkeep is true", async function () {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const tx = await raffle.performUpkeep([])
                  assert(tx)
              })
              it("reverts when checkUpkeep is false", async function () {
                  await expect(raffle.performUpkeep("0x")).to.be.revertedWith(
                      "Raffle_UpkeepNotNeeded"
                  )
              })
              it("updates the raffle state and emits a requestId", async () => {
                  // Too many asserts in this test!
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const txResponse = await raffle.performUpkeep("0x") // emits requestId
                  const txReceipt = await txResponse.wait(1) // waits 1 block
                  const raffleState = await raffle.getRaffleState() // updates state
                  const requestId = txReceipt.events[1].args.requestId
                  assert(requestId.toNumber() > 0)
                  assert(raffleState == 1) // 0 = open, 1 = calculating
              })
          })

          beforeEach(async function () {
              await raffle.enterRaffle({ value: raffleEntranceFee })
              await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
              await network.provider.send("evm_mine", [])
          })
          it("can only be called after performUpkeep", async function () {
              await expect(
                  vrfCoordinatorV2Mock.fulfillRandomWords(0, raffle.address)
              ).to.be.revertedWith("nonexistent request")
              await expect(
                  vrfCoordinatorV2Mock.fulfillRandomWords(1, raffle.address)
              ).to.be.revertedWith("nonexistent request")
          })
          // WAY TOO BIG
          it("picks a winner , resest the lottery , and sends money", async () => {
              const additonalEnternace = 3
              const startingAccountIndex = 2 // deployer = 0
              const accounts = await ethers.getSigners()

              // connecting 3 extra people to the rafffle , not including the deployer which makes it 4
              for (
                  let i = startingAccountIndex;
                  i < startingAccountIndex + additonalEnternace;
                  i++
              ) {
                  const accountConnectedRaffle = raffle.connect(accounts[i])
                  await accountConnectedRaffle.enterRaffle({ value: raffleEntranceFee })
              }
              const startingTimeStamp = await raffle.getLatestTimeStamp()

              // performUpKeep {mock being chainLink keepers}
              // fullfillRandomWords {mock being the chainLink VRF}
              // IF WE ON TESTNET : we have to wait for the fullfillRandomWords
              await new Promise(async (resolve, reject) => {
                  // Listening for the winnerPicked Event
                  raffle.once("WinnerPicked", async () => {
                      console.log("Found the event")

                      try {
                          const recentWinner = await raffle.getRecentWinner()
                          console.log(`the Last winner was : ${recentWinner}`)

                          console.log(
                              "------------------------All Accounts------------------------"
                          )
                          console.log(accounts[0].address)
                          console.log(accounts[1].address)
                          console.log(accounts[2].address)
                          console.log(accounts[3].address)

                          const raffleState = await raffle.getRaffleState()
                          const endingTimeStamp = await raffle.getLatestTimeStamp()
                          const numPlayers = await raffle.getNumberOfPlayer()
                          const winnerEndingBalance = await accounts[2].getBalance()

                          // asserts
                          assert.equal(numPlayers.toString(), "0")
                          assert.equal(raffleState.toString(), "0")
                          assert(endingTimeStamp > startingTimeStamp)

                          // doing the math to make sure the winner gets the right amount

                          assert.equal(
                              winnerEndingBalance.toString(),
                              winnerStartingBalace
                                  .add(
                                      raffleEntranceFee
                                          .mul(additonalEnternace)
                                          .add(raffleEntranceFee)
                                  )
                                  .toString()
                          )
                      } catch (error) {
                          reject(error)
                      }
                      resolve()
                  })
                  // setting up a listener

                  // below , we will fire the event , and the listner will pick it up , and resolve
                  const tx = await raffle.performUpkeep([])
                  const txReceipt = await tx.wait(1)
                  const winnerStartingBalace = await accounts[2].getBalance()
                  await vrfCoordinatorV2Mock.fulfillRandomWords(
                      txReceipt.events[1].args.requestId,
                      raffle.address
                  )
              })
          })
      })
