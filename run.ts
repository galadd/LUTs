import { AnchorProvider } from "@coral-xyz/anchor";
import { 
  AddressLookupTableProgram, 
  Keypair, 
  LAMPORTS_PER_SOL, 
  PublicKey, 
  SystemProgram, 
  Transaction, 
  TransactionInstruction, 
  TransactionMessage, 
  VersionedTransaction 
} from "@solana/web3.js";
import assert from "assert";

/**
 * This is a simple script that shows how to use versioned transactions and lookup tables on Solana.
 * It constructs and executes a transaction containing 50 SystemProgram.transfer instructions to different 
 * recipients. In a legacy transaction, this would fail as it would result in a transaction payload that's 
 * above the limit of 1232. However, we show here that it works with versioned transactions and LUTs.
 * 
 * We also compare the serialized size of the legacy transaction vs the versioned transaction, showing that
 * the versioned transaction is way less in size despite it being comprised of exactly the same instructions
 * as its counterpart. This is entirely due to lookup tables and their role in versioned transactions!
 * 
 * PREREQUISITES: This example assumes that you have the Solana CLI installed.
 * 
 * USAGE: 
 * - Start the test-validator with solana-test-validator and make sure it's running.
 * - Run `yarn start`. (Note that the keypair in provider/provider.json is overwritten each time this is called).
 */

(async () => {
  const provider = AnchorProvider.env();

  // We're testing on localnet so we request an airdrop:
  await provider.connection.confirmTransaction(
    await provider.connection.requestAirdrop(
      provider.publicKey,
      300 * LAMPORTS_PER_SOL // 200 sol
    )
  );

  // We generate 50 accounts for our experiment. Each of them will receive 20 lamports.
  let recipients = new Array<PublicKey>();
  for (let i = 0; i < 50; ++i) {
    recipients.push(Keypair.generate().publicKey);
  }
  let instructions = new Array<TransactionInstruction>;

  // Generate 50 instructions to transfer lamports to each recipient.
  for (let i = 0; i < 50; ++i) {
    instructions.push(SystemProgram.transfer({
      fromPubkey: provider.publicKey,
      toPubkey: recipients[i],
      lamports: 4 * LAMPORTS_PER_SOL // 4 sol to each wallet
    }));
  }

  // Create the Legacy transaction and add all the instructions.
  const blockInfo = await provider.connection.getLatestBlockhash();
  let legacyTransaction = new Transaction({
    feePayer: provider.publicKey,
    blockhash: blockInfo.blockhash,
    lastValidBlockHeight: blockInfo.lastValidBlockHeight
  });
  for (let instruction of instructions) {
    legacyTransaction.add(instruction);
  }

  // let legacyTransactionSize = legacyTransaction.serialize({
  // requireAllSignatures: false
  // }).length; 

  // Even attempting to serialize the legacy transaction as shown above results in a 
  // `Transaction too large` error due to exceeding the limit of 1232 bytes.
  //
  // The solution is to use a versioned transaction with lookup tables. The first step in doing
  // that is to create the lookup table:
  const [create, lut] = AddressLookupTableProgram.createLookupTable(
    {
      authority: provider.publicKey,
      payer: provider.publicKey,
      recentSlot: await provider.connection.getSlot("finalized")
    }
  );
  await provider.sendAndConfirm(new Transaction().add(create));

  // Next we extend the lookup tables in batches of 15 since doing all of it 
  // at once would make us exceed transaction limits.
  // We add the system program and the provider pubkey as they are also accounts
  // needed for the instruction.
  //
  // NOTE: We can get away with doing this because SystemProgram.transfer is a simple
  // instruction and we know its account inputs offhand. For other more complicated 
  // examples, a better way to get the lookupAccounts is to iterate over each instruction
  // and accumulate its account keys.
  let lookupAccounts = [SystemProgram.programId, provider.publicKey].concat(recipients);
  const batch = 15;
  for (let i = 0; i < lookupAccounts.length; i += batch) {
    const extend = new Transaction().add(AddressLookupTableProgram.extendLookupTable(
      {
        payer: provider.publicKey,
        authority: provider.publicKey,
        lookupTable: lut,
        addresses: lookupAccounts.slice(i, i + batch)
      }
    ));
    await provider.sendAndConfirm(extend);
  }

  // We usually cannot use a lookup table in a transaction until some time has elapsed
  // since its creation. This period is required for the lookup table to be activated,
  // and using the lookup table in a transaction before it is fully activated results in an error.
  //
  // Here, we simply wait for 2000 ms:
  function sleep(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  await sleep(2000);
  // Fetch our lookup table.
  const lookupTable = (await provider.connection.getAddressLookupTable(lut)).value;
  if (lookupTable === null) {
    // Should be impossible since we created it above.
    throw new Error("Lookup table is uninitialized");
  }

  // And finally we construct our transaction message and compile it to a v0 transaction.
  const message = new TransactionMessage({
    payerKey: provider.publicKey,
    recentBlockhash: (await provider.connection.getLatestBlockhash()).blockhash,
    instructions,
  });
  let v0Transaction = new VersionedTransaction(message.compileToV0Message([lookupTable]));
  v0Transaction = await provider.wallet.signTransaction(v0Transaction);
  const v0TransactionSize = v0Transaction.serialize().length;
  console.log(`The size(in bytes) of our v0 Transaction is ${v0TransactionSize}.`);

  // We send and confirm the transaction:
  let sig = await provider.connection.sendTransaction(v0Transaction);
  await provider.connection.confirmTransaction(sig, "finalized");
  console.log(`Transaction executed with signature ${sig}.`);

  // Now we check the final state of our accounts to make sure that the transaction was successful.
  let i = 0;
  for (let recipient of recipients) {
    let balance = await provider.connection.getBalance(recipient, "finalized");
    console.log(`Recipient ${i}'s balance: ${balance}.`);
    ++i;
    assert(balance >= 4 * LAMPORTS_PER_SOL);
  }
})().catch(console.error)