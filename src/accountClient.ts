import {
  AnchorProvider,
  IdlAccounts,
  Program,
  Provider,
  Wallet,
} from '@coral-xyz/anchor';
import {
  Group,
  MangoAccount,
  MangoClient,
} from '@blockworks-foundation/mango-v4';
import {
  AccountInfo,
  Cluster,
  Connection,
  Keypair,
  MemcmpFilter,
  PublicKey,
} from '@solana/web3.js';
import { FERMI_V1_IDL, FermiV1Idl } from './idl/fermi_v1';
import { FERMI_R9_MAINNET, requireFermiV1Deployment } from './deployments';

export { FERMI_V1_IDL } from './idl/fermi_v1';
export type { FermiV1Idl } from './idl/fermi_v1';

export type FermiV1Account = MangoAccount &
  Pick<
    IdlAccounts<FermiV1Idl>['fermiAccount'],
    'temporaryDelegate' | 'temporaryDelegateExpiry' | 'openbookV2'
  >;
export type FermiV1Group = Group & {
  buybackFeesSwapFermiAccount: PublicKey;
};
type FermiV1ClientOptions = ConstructorParameters<typeof MangoClient>[3];

/** The seed changed in r9. Account numbers are unsigned 32-bit integers. */
export function findFermiV1AccountPda(
  programId: PublicKey,
  group: PublicKey,
  owner: PublicKey,
  accountNum = 0,
): PublicKey {
  if (
    !Number.isInteger(accountNum) ||
    accountNum < 0 ||
    accountNum > 0xffffffff
  ) {
    throw new Error('accountNum must be an unsigned 32-bit integer');
  }
  const num = Buffer.alloc(4);
  num.writeUInt32LE(accountNum);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('FermiAccount'), group.toBuffer(), owner.toBuffer(), num],
    programId,
  )[0];
}

/**
 * Uses r9's IDL for every instruction and decoder. The upstream package only
 * supplies account models and transaction helpers. Legacy method names remain
 * aliases; none of them constructs a client with the upstream Mango IDL.
 */
export class FermiV1AccountClient extends MangoClient {
  readonly fermiProgram: Program<FermiV1Idl>;

  constructor(
    provider: Provider,
    cluster: Cluster,
    programId: PublicKey,
    opts: FermiV1ClientOptions = {},
  ) {
    const program = new Program(FERMI_V1_IDL, programId, provider);
    // The base class types its program against Mango's older IDL. The r9 IDL
    // retains the instruction surface used by its transaction helpers.
    super(program as unknown as MangoClient['program'], programId, cluster, {
      turnOffPriceImpactLoading: true,
      ...opts,
      idsSource: 'get-program-accounts',
    });
    this.fermiProgram = program;
  }

  static connect(
    provider: Provider,
    cluster: Cluster,
    programId: PublicKey,
    opts?: FermiV1ClientOptions,
  ): FermiV1AccountClient {
    return new FermiV1AccountClient(provider, cluster, programId, opts);
  }

  static connectDefault(clusterUrl: string): FermiV1AccountClient {
    const opts = AnchorProvider.defaultOptions();
    const provider = new AnchorProvider(
      new Connection(clusterUrl, opts),
      new Wallet(Keypair.generate()),
      opts,
    );
    return FermiV1AccountClient.connect(
      provider,
      'mainnet-beta',
      new PublicKey(FERMI_R9_MAINNET.programId),
    );
  }

  static connectForGroupName(
    provider: Provider,
    groupName: string,
  ): FermiV1AccountClient {
    const deployment = requireFermiV1Deployment(groupName);
    return FermiV1AccountClient.connect(
      provider,
      deployment.cluster as Cluster,
      new PublicKey(deployment.programId),
    );
  }

  getMangoAccountFromAi(
    pk: PublicKey,
    ai: AccountInfo<Buffer>,
  ): FermiV1Account {
    if (!ai || !ai.owner.equals(this.programId)) {
      throw new Error(
        `Fermi account ${pk.toBase58()} is missing or has the wrong program owner`,
      );
    }
    const decoded = this.fermiProgram.coder.accounts.decode<
      IdlAccounts<FermiV1Idl>['fermiAccount']
    >('fermiAccount', ai.data);
    return Object.assign(MangoAccount.from(pk, decoded), {
      temporaryDelegate: decoded.temporaryDelegate,
      temporaryDelegateExpiry: decoded.temporaryDelegateExpiry,
      openbookV2: decoded.openbookV2,
    });
  }

  async getFermiAccount(pk: PublicKey): Promise<FermiV1Account> {
    const ai = await this.connection.getAccountInfo(pk);
    return this.getMangoAccountFromAi(pk, ai as AccountInfo<Buffer>);
  }

  async getMangoAccount(
    pk: PublicKey,
    loadSerum3Oo = false,
  ): Promise<FermiV1Account> {
    const account = await this.getFermiAccount(pk);
    if (loadSerum3Oo) await account.reloadSerum3OpenOrders(this);
    return account;
  }

  async getFermiAccountForOwner(
    group: Group,
    owner: PublicKey,
    accountNum = 0,
  ): Promise<FermiV1Account | undefined> {
    const pk = findFermiV1AccountPda(
      this.programId,
      group.publicKey,
      owner,
      accountNum,
    );
    const ai = await this.connection.getAccountInfo(pk);
    if (!ai) return undefined;
    const account = this.getMangoAccountFromAi(pk, ai);
    if (
      !account.group.equals(group.publicKey) ||
      !account.owner.equals(owner) ||
      account.accountNum !== accountNum
    ) {
      throw new Error(
        'Fermi account does not match the requested group, owner and account number',
      );
    }
    return account;
  }

  private async scanFermiAccounts(
    group: Group,
    filters: MemcmpFilter[] = [],
    loadSerum3Oo = false,
  ): Promise<FermiV1Account[]> {
    const discriminator =
      this.fermiProgram.coder.accounts.memcmp('fermiAccount');
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { memcmp: discriminator },
        { memcmp: { offset: 8, bytes: group.publicKey.toBase58() } },
        ...filters,
      ],
    });
    const decoded = accounts.map(({ pubkey, account }) =>
      this.getMangoAccountFromAi(pubkey, account),
    );
    if (loadSerum3Oo) {
      await Promise.all(
        decoded.map((account) => account.reloadSerum3OpenOrders(this)),
      );
    }
    return decoded;
  }

  getFermiAccountsForOwner(group: Group, owner: PublicKey) {
    return this.scanFermiAccounts(group, [
      { memcmp: { offset: 40, bytes: owner.toBase58() } },
    ]);
  }

  getMangoAccountsForOwner(
    group: Group,
    owner: PublicKey,
    loadSerum3Oo = false,
  ) {
    return this.scanFermiAccounts(
      group,
      [{ memcmp: { offset: 40, bytes: owner.toBase58() } }],
      loadSerum3Oo,
    );
  }

  getMangoAccountsForDelegate(
    group: Group,
    delegate: PublicKey,
    loadSerum3Oo = false,
  ) {
    return this.scanFermiAccounts(
      group,
      [{ memcmp: { offset: 104, bytes: delegate.toBase58() } }],
      loadSerum3Oo,
    );
  }

  getAllMangoAccounts(group: Group, loadSerum3Oo = false) {
    return this.scanFermiAccounts(group, [], loadSerum3Oo);
  }

  async getMangoAccountForOwner(
    group: Group,
    owner: PublicKey,
    accountNum: number,
    loadSerum3Oo = false,
  ) {
    const account = await this.getFermiAccountForOwner(
      group,
      owner,
      accountNum,
    );
    if (account && loadSerum3Oo) await account.reloadSerum3OpenOrders(this);
    return account;
  }

  async createFermiAccountIx(
    group: Group,
    accountNum = 0,
    name = '',
    tokenCount = 1,
    serum3Count = 0,
    perpCount = 3,
    perpOoCount = 32,
  ) {
    if (serum3Count !== 0)
      throw new Error('r9 disables Serum3 slots; serum3Count must be 0');
    const owner = (this.program.provider as AnchorProvider).wallet.publicKey;
    return this.fermiProgram.methods
      .accountCreate(
        accountNum,
        tokenCount,
        serum3Count,
        perpCount,
        perpOoCount,
        name,
      )
      .accounts({
        group: group.publicKey,
        account: findFermiV1AccountPda(
          this.programId,
          group.publicKey,
          owner,
          accountNum,
        ),
        owner,
        payer: owner,
      })
      .instruction();
  }

  async createFermiAccount(
    group: Group,
    accountNum?: number,
    name?: string,
    tokenCount?: number,
    serum3Count?: number,
    perpCount?: number,
    perpOoCount?: number,
  ) {
    const ix = await this.createFermiAccountIx(
      group,
      accountNum,
      name,
      tokenCount,
      serum3Count,
      perpCount,
      perpOoCount,
    );
    return this.sendAndConfirmTransactionForGroup(group, [ix]);
  }

  createMangoAccount(
    ...args: Parameters<FermiV1AccountClient['createFermiAccount']>
  ) {
    return this.createFermiAccount(...args);
  }

  private groupFrom(
    pk: PublicKey,
    decoded: IdlAccounts<FermiV1Idl>['group'],
  ): FermiV1Group {
    const group = Group.from(pk, {
      ...decoded,
      buybackFeesSwapMangoAccount: decoded.buybackFeesSwapFermiAccount,
    });
    return Object.assign(group, {
      buybackFeesSwapFermiAccount: decoded.buybackFeesSwapFermiAccount,
    });
  }

  async getGroup(pk: PublicKey): Promise<FermiV1Group> {
    const group = this.groupFrom(
      pk,
      await this.fermiProgram.account.group.fetch(pk),
    );
    await group.reloadAll(this);
    return group;
  }

  async getGroupsForCreator(creator: PublicKey): Promise<FermiV1Group[]> {
    const groups = await this.fermiProgram.account.group.all([
      { memcmp: { offset: 8, bytes: creator.toBase58() } },
    ]);
    return Promise.all(
      groups.map(async ({ publicKey, account }) => {
        const group = this.groupFrom(publicKey, account);
        await group.reloadAll(this);
        return group;
      }),
    );
  }

  async getGroupForCreator(
    creator: PublicKey,
    groupNum: number,
  ): Promise<FermiV1Group> {
    const group = (await this.getGroupsForCreator(creator)).find(
      (candidate) => candidate.groupNum === groupNum,
    );
    if (!group)
      throw new Error(
        `Fermi group ${groupNum} not found for ${creator.toBase58()}`,
      );
    return group;
  }
}
