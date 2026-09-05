// @ts-nocheck
export class ProfileLoader {
  constructor(fetchProfile) {
    this.fetchProfile = fetchProfile;
    this.current = undefined;
  }

  async load(userId) {
    const profile = await this.fetchProfile(userId);
    this.current = profile;
    return profile;
  }
}
